import { SlashCommandBuilder } from 'discord.js';
import { requireAdmin } from './helpers.js';

export const statsCommand = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show bot stats'),

  async execute({ interaction, store, downloadJobs, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    await interaction.reply({
      content: [
        '**Bot stats**',
        `Tracked users: ${store.getTrackedUsersCount()}`,
        `Nerded users: ${store.getNerdedUsersCount()}`,
        `Stored messages: ${store.getTotalStoredMessages()}`,
        `Active downloads: ${downloadJobs.getActiveJobCount()}`,
        `Global reply chance: ${store.getReplyChancePercent()}%`,
        `Always-reply mention user: <@${config.alwaysReplyUserId}>`,
      ].join('\n'),
      ephemeral: true,
    });
  },
};
