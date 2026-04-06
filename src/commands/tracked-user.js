import { SlashCommandBuilder } from 'discord.js';
import { formatTrackedUserSummary, requireAdmin } from './helpers.js';

export const trackedUserCommand = {
  data: new SlashCommandBuilder()
    .setName('tracked-user')
    .setDescription('Show tracked-user details')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('The user to inspect')
        .setRequired(true),
    ),

  async execute({ interaction, store, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    const targetUser = interaction.options.getUser('user', true);
    const summary = store.getUserSummary(targetUser.id);

    await interaction.reply({
      content: formatTrackedUserSummary(summary, config),
      ephemeral: true,
    });
  },
};
