import { SlashCommandBuilder } from 'discord.js';
import { formatTrackedUserSummary, requireAdmin } from './helpers.js';

export const replyModeCommand = {
  data: new SlashCommandBuilder()
    .setName('reply-mode')
    .setDescription('Show or update reply chance override for one user')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('The user to inspect or update')
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName('percent')
        .setDescription('Override reply chance for this user (0-100)')
        .setMinValue(0)
        .setMaxValue(100),
    ),

  async execute({ interaction, store, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    const targetUser = interaction.options.getUser('user', true);
    const percent = interaction.options.getInteger('percent');

    if (percent !== null) {
      store.setUserReplyChanceOverride(targetUser.id, percent);
    }

    const summary = store.getUserSummary(targetUser.id);

    await interaction.reply({
      content: [
        percent === null
          ? 'Current reply mode:'
          : `Reply mode updated to ${summary.replyChanceOverride}% for <@${targetUser.id}>.`,
        '',
        formatTrackedUserSummary(summary, config),
        '',
        'Setting a user to `0%` disables random auto-replies for that user.',
      ].join('\n'),
      ephemeral: true,
    });
  },
};
