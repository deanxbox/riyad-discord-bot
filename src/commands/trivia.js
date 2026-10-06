import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { isTriviaExpired } from '../services/data-store.js';
import { getGuildMembers } from '../services/guild-members.js';

export const TRIVIA_BUTTON_PREFIX = 'trivia:';

const nameOf = (members, id) => members.get(id)?.displayName ?? `<@${id}>`;
// Where and when the mystery message was originally sent (<t:..> renders in each viewer's own timezone).
const sourceLine = (client, guildId, at) => {
  const unix = Math.floor(Date.parse(at) / 1000);
  const server = (guildId && client?.guilds?.cache?.get(guildId)?.name) || 'an unknown server';
  return `📍 Said in **${server}**${Number.isFinite(unix) ? ` on <t:${unix}:F>` : ''}`;
};
const sourceBlock = source => (source ? `\n${source}` : '');
const streakNote = streak => (streak <= -3 ? ` 🧊 **${-streak} loss streak**` : '');
const guessLines = (guesses, members, correctId, createdAt, live = false) => guesses
  .filter(g => g.guessId !== correctId)
  .map(g => `• **${nameOf(members, g.userId)}** ${live ? 'has guessed incorrectly!' : `guessed ${nameOf(members, g.guessId)}`}${g.at ? ` (${((g.at - Date.parse(createdAt)) / 1000).toFixed(2)}s)` : ''}${streakNote(g.streak ?? 0)}`).join('\n');
const guessBlock = (lines, final = true) => (lines ? `\n\n❌ **${final ? 'Wrong guesses' : 'Incorrect so far'}:**\n${lines.slice(0, 800)}` : '');

const starting = new Set();
const ALREADY_ACTIVE = 'There\'s already an active trivia question in this channel! Answer it or wait for it to expire first.';

// Guild members where available, otherwise the user's global profile (they may have left the server).
async function resolvePeople(client, guildMembers, ids) {
  const people = new Map();
  await Promise.all(ids.map(async id => {
    const member = guildMembers.get(id);
    if (member) return people.set(id, member);
    const user = client?.users?.cache?.get(id) ?? await client?.users?.fetch(id).catch(() => null);
    if (user) people.set(id, { displayName: user.globalName ?? user.username, user });
  }));
  return people;
}

export const triviaCommand = {
  data: new SlashCommandBuilder()
    .setName('trivia')
    .setDescription('Start a trivia round — guess who said the mystery message!'),

  async execute(context) {
    const guildId = context.interaction.channelId; // one live trivia per channel
    // Guards the async gap between the active-question check and the question being stored.
    if (guildId && starting.has(guildId)) {
      await context.interaction.reply({ content: ALREADY_ACTIVE, ephemeral: true });
      return;
    }
    if (guildId) starting.add(guildId);
    try {
      await startTrivia(context);
    } finally {
      if (guildId) starting.delete(guildId);
    }
  },
};

async function startTrivia({ interaction, store }) {
    const guild = interaction.guild;
    const channelId = interaction.channelId;

    if (!guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }

    const activeQuestion = store.getActiveTriviaQuestion(channelId);
    if (activeQuestion && isTriviaExpired(activeQuestion, Date.now(), store.triviaLifetimeMs)) {
      store.clearActiveTriviaQuestion(channelId);
    } else if (activeQuestion) {
      await interaction.reply({
        content: ALREADY_ACTIVE,
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();
    const guildMembers = await getGuildMembers(guild);

    // Everyone with downloaded messages is eligible, whether or not they are still in the server.
    const eligibleIds = store.listTrackedUsers().filter(id => store.getMessageCount(id) > 0);

    if (eligibleIds.length < 1) {
      await interaction.editReply('No users with downloaded messages are available. Use `/download` first!');
      return;
    }

    const correctUserId = eligibleIds[Math.floor(Math.random() * eligibleIds.length)];
    const sample = store.getRandomMessageWithMetadata(correctUserId);
    const messageContent = sample?.content;

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

    store.setActiveTriviaQuestion(channelId, { correctUserId, messageContent, optionUserIds, sourceGuildId: sample.guild_id, sourceAt: sample.created_at });
    const source = sourceLine(interaction.client, sample.guild_id, sample.created_at);
    const members = await resolvePeople(interaction.client, guildMembers, optionUserIds);

    const posted = await interaction.editReply({
      content: mediaLinks(messageContent) || undefined,
      embeds: [buildTriviaEmbed(messageContent)],
      components: buildTriviaComponents(optionUserIds, members),
    });

    store.restartTriviaClock(channelId); // clock starts when the question is on screen, not when it was saved

    // ponytail: in-memory timer, lost on restart (message then stays unexpired); persist deadlines if that matters
    const createdAt = store.getActiveTriviaQuestion(channelId)?.created_at;
    setTimeout(async () => {
      try {
        const active = store.getActiveTriviaQuestion(channelId);
        if (active?.created_at !== createdAt) return; // solved or replaced
        const guesses = JSON.parse(active.guesses ?? '[]');
        store.clearActiveTriviaQuestion(channelId);
        const correctMember = members.get(correctUserId);
        await posted.edit({
          embeds: [buildTriviaEmbed(messageContent, { expired: true, source, correctName: correctMember?.displayName ?? `<@${correctUserId}>`, guessLines: guessLines(guesses, members, correctUserId, createdAt) })],
          components: buildTriviaComponents(optionUserIds, members, { disabled: true, correctUserId }),
        });
      } catch (error) {
        console.error('Failed to expire trivia message:', error);
      }
    }, store.triviaLifetimeMs + 500).unref();
}

export async function handleTriviaButton(interaction, { store }) {
  const selectedUserId = interaction.customId.slice(TRIVIA_BUTTON_PREFIX.length);
  const guildId = interaction.guildId;
  const answererId = interaction.user.id;

  const attempt = store.triviaAttempt(guildId, answererId, selectedUserId, interaction.channelId);

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
    store.clearActiveTriviaQuestion(interaction.channelId);

    const guild = interaction.guild;
    const optionUserIds = JSON.parse(question.option_user_ids);
    const people = await resolvePeople(interaction.client, guild.members.cache, optionUserIds);
    const correctMember = people.get(question.correct_user_id);
    const correctName = correctMember?.displayName ?? `<@${question.correct_user_id}>`;
    const winnerName = interaction.member?.displayName ?? interaction.user.username;

    const embed = buildTriviaEmbed(question.message_content, {
      solved: true,
      source: sourceLine(interaction.client, question.source_guild_id, question.source_at),
      winnerName,
      correctName,
      elapsedMs,
      bonus,
      bonusSeconds,
      streak: attempt.streak,
      guessLines: guessLines(JSON.parse(question.guesses ?? '[]'), people, question.correct_user_id, question.created_at),
    });

    await interaction.update({
      embeds: [embed],
      components: buildTriviaComponents(optionUserIds, people, {
        disabled: true,
        correctUserId: question.correct_user_id,
      }),
    });
  } else {
    // `question` predates this guess, so re-read the stored guesses
    const live = store.getActiveTriviaQuestion(interaction.channelId) ?? question;
    const people = await resolvePeople(interaction.client, interaction.guild.members.cache, JSON.parse(question.option_user_ids));
    await interaction.update({
      embeds: [buildTriviaEmbed(question.message_content, {
        guessLines: guessLines(JSON.parse(live.guesses ?? '[]'), people, question.correct_user_id, question.created_at, true),
      })],
    });
  }
}

const IMAGE_URL = /https?:\/\/\S+?\.(?:gif|png|jpe?g|webp)(?:\?\S*)?(?=\s|$)/i;
// Other links (tenor, giphy, video) can't go in an embed image; post them as content so Discord unfurls them.
const mediaLinks = text => (text.match(/https?:\/\/\S+/g) ?? []).filter(u => !IMAGE_URL.test(u)).join('\n');

function buildTriviaEmbed(messageContent, { solved = false, expired = false, source = '', winnerName, correctName, elapsedMs, bonus = false, bonusSeconds = 0, streak = 0, guessLines: lines = '' } = {}) {
  const image = messageContent.match(IMAGE_URL)?.[0];
  const display = messageContent.length > 900 ? `${messageContent.slice(0, 900)}…` : messageContent;

  if (expired) {
    return new EmbedBuilder()
      .setTitle('🎭 Trivia — Expired!')
      .setDescription(`**Who said this?**

>>> ${display}

⏰ Time's up! Nobody got it in time.
The answer was **${correctName}**.${sourceBlock(source)}${guessBlock(lines)}`)
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
        (streak >= 3 ? `🔥 **${winnerName}** is on a **${streak} win streak**!\n` : '') +
        `The answer was **${correctName}**.${sourceBlock(source)}${guessBlock(lines)}`,
      )
      .setColor(0x57F287)
      .setImage(image ?? null)
      .setFooter({ text: 'Use /scoreboard to see the leaderboard' })
      .setTimestamp();
  }

  return new EmbedBuilder()
    .setTitle('🎭 Trivia Time!')
    .setDescription(`**Who said this?**\n\n>>> ${display}${guessBlock(lines, false)}`)
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
