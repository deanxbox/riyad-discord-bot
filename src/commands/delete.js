import { SlashCommandBuilder } from 'discord.js';
import { requireAdmin } from './helpers.js';

export const deleteCommand = {
  data: new SlashCommandBuilder()
    .setName('delete')
    .setDescription('Delete stored messages for a user')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('The user to delete messages from')
        .setRequired(true),
    ),

  async execute({ interaction, downloadJobs, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    const targetUser = interaction.options.getUser('user', true);
    await interaction.deferReply({ ephemeral: true });
    await downloadJobs.deleteUser(targetUser.id);

    await interaction.editReply({
      content: `Deleted all saved data for <@${targetUser.id}> and stopped active downloads.`,
    });
  },
};
