import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { isTriviaExpired } from '../services/data-store.js';
import { getGuildMembers } from '../services/guild-members.js';

export const TRIVIA_BUTTON_PREFIX = 'trivia:';

const nameOf = (members, id) => members.get(id)?.displayName ?? `<@${id}>`;
const guessLines = (guesses, members, correctId) => guesses
  .filter(g => g.guessId !== correctId)
  .map(g => `• **${nameOf(members, g.userId)}** guessed ${nameOf(members, g.guessId)}`).join('\n');
const guessBlock = lines => (lines ? `\n\n❌ **Wrong guesses:**\n${lines.slice(0, 800)}` : '');

export const triviaCommand = {
  data: new SlashCommandBuilder()
    .setName('trivia')
    .setDescription('Start a trivia round — guess who said the mystery message!'),

  async execute({ interaction, store }) {
    const guild = interaction.guild;

    if (!guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }

    const activeQuestion = store.getActiveTriviaQuestion(guild.id);
    if (activeQuestion && isTriviaExpired(activeQuestion, Date.now(), store.triviaLifetimeMs)) {
      store.clearActiveTriviaQuestion(guild.id);
    } else if (activeQuestion) {
      await interaction.reply({
        content: 'There\'s already an active trivia question in this server! Answer it first.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();
    const members = await getGuildMembers(guild);

    const eligibleIds = store.listTrackedUsers().filter(
      id => members.has(id) && store.getMessageCount(id) > 0,
    );

    if (eligibleIds.length < 1) {
      await interaction.editReply('No users with downloaded messages are currently in this server. Use `/download` first!');
      return;
    }

    const correctUserId = eligibleIds[Math.floor(Math.random() * eligibleIds.length)];
    const messageContent = store.getRandomMessage(correctUserId);

    if (!messageContent) {
      await interaction.editReply('Could not retrieve a message. Please try again.');
      return;
    }

    const optionCount = store.getTriviaOptionCount();
    const distractorPool = eligibleIds.filter(id => id !== correctUserId);

    if (distractorPool.length < optionCount - 1) {
      await interaction.editReply(`Not enough users with downloaded messages to generate options (need at least ${optionCount}).`);
      return;
    }

    const shuffledPool = fisherYates([...distractorPool]);
    const distractorIds = shuffledPool.slice(0, optionCount - 1);
    const optionUserIds = fisherYates([correctUserId, ...distractorIds]);

    store.setActiveTriviaQuestion(guild.id, { correctUserId, messageContent, optionUserIds });

    const posted = await interaction.editReply({
      content: mediaLinks(messageContent) || undefined,
      embeds: [buildTriviaEmbed(messageContent)],
      components: buildTriviaComponents(optionUserIds, members),
    });

    // ponytail: in-memory timer, lost on restart (message then stays unexpired); persist deadlines if that matters
    const createdAt = store.getActiveTriviaQuestion(guild.id)?.created_at;
    setTimeout(async () => {
      try {
        const active = store.getActiveTriviaQuestion(guild.id);
        if (active?.created_at !== createdAt) return; // solved or replaced
        const guesses = JSON.parse(active.guesses ?? '[]');
        store.clearActiveTriviaQuestion(guild.id);
        const correctMember = members.get(correctUserId);
        await posted.edit({
          embeds: [buildTriviaEmbed(messageContent, { expired: true, correctName: correctMember?.displayName ?? `<@${correctUserId}>`, guessLines: guessLines(guesses, members, correctUserId) })],
          components: buildTriviaComponents(optionUserIds, members, { disabled: true, correctUserId }),
        });
      } catch (error) {
        console.error('Failed to expire trivia message:', error);
      }
    }, store.triviaLifetimeMs + 500).unref();
  },
};

export async function handleTriviaButton(interaction, { store }) {
  const selectedUserId = interaction.customId.slice(TRIVIA_BUTTON_PREFIX.length);
  const guildId = interaction.guildId;
  const answererId = interaction.user.id;

  const attempt = store.triviaAttempt(guildId, answererId, selectedUserId);

  if (attempt.status === 'no_question') {
    await interaction.reply({ content: 'There\'s no active trivia question right now.', ephemeral: true });
    return;
  }

  if (attempt.status === 'already_answered') {
    await interaction.reply({ content: 'You\'ve already used your one attempt!', ephemeral: true });
    return;
  }

  const { question } = attempt;
  const isCorrect = selectedUserId === question.correct_user_id;

  if (isCorrect) {
    // Award point and close question before yielding to the event loop
    const elapsedMs = Date.now() - Date.parse(question.created_at);
    const bonusSeconds = store.getTriviaBonusSeconds();
    const bonus = elapsedMs <= bonusSeconds * 1000;
    store.triviaIncrementScore(answererId, guildId, bonus ? 2 : 1);
    store.clearActiveTriviaQuestion(guildId);

    const guild = interaction.guild;
    const optionUserIds = JSON.parse(question.option_user_ids);
    const correctMember = guild.members.cache.get(question.correct_user_id);
    const correctName = correctMember?.displayName ?? `<@${question.correct_user_id}>`;
    const winnerName = interaction.member?.displayName ?? interaction.user.username;

    const embed = buildTriviaEmbed(question.message_content, {
      solved: true,
      winnerName,
      correctName,
      elapsedMs,
      bonus,
      bonusSeconds,
      guessLines: guessLines(JSON.parse(question.guesses ?? '[]'), guild.members.cache, question.correct_user_id),
    });

    await interaction.update({
      embeds: [embed],
      components: buildTriviaComponents(optionUserIds, guild.members.cache, {
        disabled: true,
        correctUserId: question.correct_user_id,
      }),
    });
  } else {
    await interaction.reply({
      content: '❌ Wrong! That\'s your one attempt used up.',
      ephemeral: true,
    });
  }
}

const IMAGE_URL = /https?:\/\/\S+?\.(?:gif|png|jpe?g|webp)(?:\?\S*)?(?=\s|$)/i;
// Other links (tenor, giphy, video) can't go in an embed image; post them as content so Discord unfurls them.
const mediaLinks = text => (text.match(/https?:\/\/\S+/g) ?? []).filter(u => !IMAGE_URL.test(u)).join('\n');

function buildTriviaEmbed(messageContent, { solved = false, expired = false, winnerName, correctName, elapsedMs, bonus = false, bonusSeconds = 0, guessLines: lines = '' } = {}) {
  const image = messageContent.match(IMAGE_URL)?.[0];
  const display = messageContent.length > 900 ? `${messageContent.slice(0, 900)}…` : messageContent;

  if (expired) {
    return new EmbedBuilder()
      .setTitle('🎭 Trivia — Expired!')
      .setDescription(`**Who said this?**

>>> ${display}

⏰ Time's up! Nobody got it in time.
The answer was **${correctName}**.${guessBlock(lines)}`)
      .setColor(0xED4245)
      .setImage(image ?? null)
      .setTimestamp();
  }

  if (solved) {
    return new EmbedBuilder()
      .setTitle('🎭 Trivia — Solved!')
      .setDescription(
        `**Who said this?**\n\n>>> ${display}\n\n` +
        `✅ **${winnerName}** got it right in **${(elapsedMs / 1000).toFixed(2)}s**!\n` +
        (bonus ? `⚡ **x2 speed bonus!** Answered within ${bonusSeconds}s for 2 points.\n` : '') +
        `The answer was **${correctName}**.${guessBlock(lines)}`,
      )
      .setColor(0x57F287)
      .setImage(image ?? null)
      .setFooter({ text: 'Use /scoreboard to see the leaderboard' })
      .setTimestamp();
  }

  return new EmbedBuilder()
    .setTitle('🎭 Trivia Time!')
    .setDescription(`**Who said this?**\n\n>>> ${display}`)
    .setColor(0x5865F2)
    .setImage(image ?? null)
    .setFooter({ text: 'Each player gets one attempt — first correct answer wins a point!' })
    .setTimestamp();
}

export function buildTriviaComponents(optionUserIds, membersCache, { disabled = false, correctUserId = null } = {}) {
  const buttons = optionUserIds.map(userId => {
    const member = membersCache.get(userId);
    const nick = member?.displayName ?? `User …${userId.slice(-4)}`;
    const profile = member?.user?.globalName ?? member?.user?.username;
    const label = (profile && profile !== nick ? `${nick} (${profile})` : nick).slice(0, 80);

    let style = ButtonStyle.Primary;
    if (disabled) {
      style = userId === correctUserId ? ButtonStyle.Success : ButtonStyle.Secondary;
    }

    return new ButtonBuilder()
      .setCustomId(`${TRIVIA_BUTTON_PREFIX}${userId}`)
      .setLabel(label)
      .setStyle(style)
      .setDisabled(disabled);
  });

  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  return rows;
}

function fisherYates(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
