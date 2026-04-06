import { SlashCommandBuilder } from 'discord.js';
import { requireAdmin } from './helpers.js';
import { evaluateReplyDecision } from '../services/reply-policy.js';

export const testReplyCommand = {
  data: new SlashCommandBuilder()
    .setName('test-reply')
    .setDescription('Simulate whether Riyad would auto-reply to a user')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('The user to test')
        .setRequired(true),
    )
    .addBooleanOption((option) =>
      option
        .setName('mentioned')
        .setDescription('Whether the message mentions Riyad')
        .setRequired(false),
    )
    .addBooleanOption((option) =>
      option
        .setName('replying')
        .setDescription('Whether the message is a reply to Riyad')
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName('roll')
        .setDescription('Optional fixed roll from 0 to 99 for testing')
        .setMinValue(0)
        .setMaxValue(99),
    ),

  async execute({ interaction, store, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    const targetUser = interaction.options.getUser('user', true);
    const mentioned = interaction.options.getBoolean('mentioned') ?? false;
    const replying = interaction.options.getBoolean('replying') ?? false;
    const roll = interaction.options.getInteger('roll');
    const summary = store.getUserSummary(targetUser.id);
    const randomValue = roll ?? Math.floor(Math.random() * 100);

    const result = evaluateReplyDecision({
      userId: targetUser.id,
      tracked: summary.tracked,
      storedMessageCount: summary.messageCount,
      mentionedBot: mentioned,
      repliedToBot: replying,
      store,
      config,
      randomValue,
    });

    await interaction.reply({
      content: [
        `**Test reply for <@${targetUser.id}>**`,
        `Tracked: ${summary.tracked ? 'Yes' : 'No'}`,
        `Stored messages: ${summary.messageCount}`,
        `Mentioned Riyad: ${mentioned ? 'Yes' : 'No'}`,
        `Replying to Riyad: ${replying ? 'Yes' : 'No'}`,
        `Effective chance: ${result.effectiveReplyChancePercent}%`,
        `Roll used: ${randomValue}`,
        `Would reply: ${result.shouldReply ? 'Yes' : 'No'}`,
        `Reason: ${result.reason}`,
      ].join('\n'),
      ephemeral: true,
    });
  },
};
