import { SlashCommandBuilder } from 'discord.js';
import { requireAdmin } from './helpers.js';

export const downloadRefreshAllCommand = {
  data: new SlashCommandBuilder()
    .setName('download-refresh-all')
    .setDescription('Refresh downloads for every tracked user')
    .addIntegerOption((option) =>
      option
        .setName('message_count')
        .setDescription('Optional per-user cap for downloaded messages')
        .setMinValue(1),
    ),

  async execute({ interaction, store, downloadJobs, config }) {
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

    const trackedUsers = store.listTrackedUsers();
    const limit = interaction.options.getInteger('message_count') ?? null;

    if (!trackedUsers.length) {
      await interaction.reply({
        content: 'No tracked users to refresh.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    let refreshed = 0;
    let skipped = 0;
    let failed = 0;
    let lastRenderAt = 0;

    for (const [index, userId] of trackedUsers.entries()) {
      if (downloadJobs.getJobStatus(interaction.guildId, userId)) {
        skipped += 1;
        continue;
      }

      const render = async (message) => {
        const now = Date.now();

        if (now - lastRenderAt < 1200) {
          return;
        }

        lastRenderAt = now;

        await interaction.editReply(message).catch(() => {});
      };

      await render(
        `Refreshing tracked users: ${index + 1}/${trackedUsers.length}\n` +
        `Current user: <@${userId}>\n` +
        `Completed: ${refreshed}\nSkipped: ${skipped}\nFailed: ${failed}`,
      );

      const { job, created } = downloadJobs.startHeadless({
        guildId: interaction.guildId,
        requestedById: interaction.user.id,
        targetUserId: userId,
        limit,
        onProgress: async (activeJob) => {
          await render(
            `Refreshing tracked users: ${index + 1}/${trackedUsers.length}\n` +
            `Current user: <@${userId}>\n` +
            `Status: ${activeJob.status}\n` +
            `Downloaded: ${activeJob.downloadedCount}/${activeJob.totalResults ?? 'unknown'}\n` +
            `Completed: ${refreshed}\nSkipped: ${skipped}\nFailed: ${failed}`,
          );
        },
      });

      if (!created) {
        skipped += 1;
        continue;
      }

      const result = await job.completion;

      if (result.ok) {
        refreshed += 1;
      } else if (result.cancelled) {
        failed += 1;
      } else {
        failed += 1;
      }
    }

    await interaction.editReply(
      `Finished refreshing tracked users.\nCompleted: ${refreshed}\nSkipped: ${skipped}\nFailed: ${failed}`,
    );
  },
};
