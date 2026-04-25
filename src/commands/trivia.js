import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder } from 'discord.js';

export const TRIVIA_BUTTON_PREFIX = 'trivia:';

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

    if (store.getActiveTriviaQuestion(guild.id)) {
      await interaction.reply({
        content: 'There\'s already an active trivia question in this server! Answer it first.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();
    await guild.members.fetch();

    const memberIds = new Set(guild.members.cache.keys());
    const eligibleIds = store.listTrackedUsers().filter(
      id => memberIds.has(id) && store.getMessageCount(id) > 0,
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

    const distractorPool = guild.members.cache
      .filter(m => !m.user.bot && m.id !== correctUserId)
      .map(m => m.id);

    if (distractorPool.length < 3) {
      await interaction.editReply('Not enough members in this server to generate options (need at least 4 non-bot members).');
      return;
    }

    const shuffledPool = fisherYates([...distractorPool]);
    const distractorIds = shuffledPool.slice(0, 3);
    const optionUserIds = fisherYates([correctUserId, ...distractorIds]);

    store.setActiveTriviaQuestion(guild.id, { correctUserId, messageContent, optionUserIds });

    await interaction.editReply({
      embeds: [buildTriviaEmbed(messageContent)],
      components: buildTriviaComponents(optionUserIds, guild.members.cache),
    });
  },
};

export async function handleTriviaButton(interaction, { store }) {
  const selectedUserId = interaction.customId.slice(TRIVIA_BUTTON_PREFIX.length);
  const guildId = interaction.guildId;
  const answererId = interaction.user.id;

  const attempt = store.triviaAttempt(guildId, answererId);

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
    store.triviaIncrementScore(answererId, guildId);
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

function buildTriviaEmbed(messageContent, { solved = false, winnerName, correctName } = {}) {
  const display = messageContent.length > 900 ? `${messageContent.slice(0, 900)}…` : messageContent;

  if (solved) {
    return new EmbedBuilder()
      .setTitle('🎭 Trivia — Solved!')
      .setDescription(
        `**Who said this?**\n\n>>> ${display}\n\n` +
        `✅ **${winnerName}** got it right!\n` +
        `The answer was **${correctName}**.`,
      )
      .setColor(0x57F287)
      .setFooter({ text: 'Use /scoreboard to see the leaderboard' })
      .setTimestamp();
  }

  return new EmbedBuilder()
    .setTitle('🎭 Trivia Time!')
    .setDescription(`**Who said this?**\n\n>>> ${display}`)
    .setColor(0x5865F2)
    .setFooter({ text: 'Each player gets one attempt — first correct answer wins a point!' })
    .setTimestamp();
}

export function buildTriviaComponents(optionUserIds, membersCache, { disabled = false, correctUserId = null } = {}) {
  const buttons = optionUserIds.map(userId => {
    const member = membersCache.get(userId);
    const label = (member?.displayName ?? `User …${userId.slice(-4)}`).slice(0, 80);

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

  return [new ActionRowBuilder().addComponents(buttons)];
}

function fisherYates(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
