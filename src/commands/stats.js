import process from 'node:process';
import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { getVoiceConnections } from '@discordjs/voice';
import { requireAdmin } from './helpers.js';

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [
    days ? `${days}d` : null,
    hours ? `${hours}h` : null,
    minutes ? `${minutes}m` : null,
    `${seconds}s`,
  ].filter(Boolean).join(' ');
}

export const statsCommand = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show bot stats'),

  async execute({ interaction, client, store, downloadJobs, nextReplyQueue, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    const memoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const embed = new EmbedBuilder()
      .setTitle('Riyad Bot Stats')
      .setColor(0x2b6cb0)
      .addFields(
        { name: 'Uptime', value: formatDuration(client.uptime ?? 0), inline: true },
        { name: 'Ping', value: `${Math.round(client.ws.ping)}ms`, inline: true },
        { name: 'Memory', value: `${memoryMb} MB`, inline: true },
        { name: 'Tracked Users', value: String(store.getTrackedUsersCount()), inline: true },
        { name: 'Stored Messages', value: String(store.getTotalStoredMessages()), inline: true },
        { name: 'Active Downloads', value: String(downloadJobs.getActiveJobCount()), inline: true },
        { name: 'Queued Next Replies', value: String(nextReplyQueue.size()), inline: true },
        { name: 'Voice Connections', value: String(getVoiceConnections().size), inline: true },
        { name: 'Global Reply Chance', value: `${store.getReplyChancePercent()}%`, inline: true },
      )
      .setFooter({
        text: `Always-reply mention user: ${config.alwaysReplyUserId}`,
      })
      .setTimestamp(new Date());

    await interaction.reply({
      embeds: [embed],
    });
  },
};
