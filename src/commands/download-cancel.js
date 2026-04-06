import { SlashCommandBuilder } from 'discord.js';
import { requireAdmin } from './helpers.js';

export const downloadCancelCommand = {
  data: new SlashCommandBuilder()
    .setName('download-cancel')
    .setDescription('Cancel an active download for a user')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('The user whose download should be cancelled')
        .setRequired(true),
    ),

  async execute({ interaction, downloadJobs, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'This command only works inside a server.',
        ephemeral: true,
      });
      return;
    }

    const targetUser = interaction.options.getUser('user', true);
    const result = downloadJobs.cancelJob(interaction.guildId, targetUser.id);

    await interaction.reply({
      content: result.cancelled
        ? `Cancellation requested for <@${targetUser.id}>.`
        : result.reason,
      ephemeral: true,
    });
  },
};
