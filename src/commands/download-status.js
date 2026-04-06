import { SlashCommandBuilder } from 'discord.js';
import { formatDownloadJobSummary, formatTrackedUserSummary, requireAdmin } from './helpers.js';

export const downloadStatusCommand = {
  data: new SlashCommandBuilder()
    .setName('download-status')
    .setDescription('Show active download status')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('The user to inspect')
        .setRequired(false),
    ),

  async execute({ interaction, downloadJobs, store, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    const targetUser = interaction.options.getUser('user');

    if (!targetUser) {
      const activeJobs = downloadJobs.getActiveJobs();

      await interaction.reply({
        content: activeJobs.length
          ? `**Active downloads:**\n${activeJobs.map((job) => `<@${job.targetUserId}>: ${job.status}, ${job.downloadedCount} messages`).join('\n')}`
          : 'No active download jobs.',
        ephemeral: true,
      });
      return;
    }

    const job = downloadJobs.getJobStatus(interaction.guildId, targetUser.id);
    const summary = store.getUserSummary(targetUser.id);

    await interaction.reply({
      content: [
        formatTrackedUserSummary(summary, config),
        '',
        `**Download job:**`,
        formatDownloadJobSummary(job),
      ].join('\n'),
      ephemeral: true,
    });
  },
};
