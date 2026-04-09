import { SlashCommandBuilder } from 'discord.js';
import { getVoiceConnection } from '@discordjs/voice';
import { requireAdmin } from './helpers.js';

export const leaveCommand = {
  data: new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave a voice channel by ID')
    .addStringOption((option) =>
      option
        .setName('voice_channel_id')
        .setDescription('The voice channel ID to leave')
        .setRequired(true),
    ),

  async execute({ interaction, client, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    const voiceChannelId = interaction.options.getString('voice_channel_id', true);
    const channel = await client.channels.fetch(voiceChannelId).catch(() => null);

    if (!channel?.guild) {
      await interaction.reply({
        content: 'That channel ID was not found in a guild.',
        ephemeral: true,
      });
      return;
    }

    const connection = getVoiceConnection(channel.guild.id);

    if (!connection) {
      await interaction.reply({
        content: 'Riyad is not connected to a voice channel in that guild.',
        ephemeral: true,
      });
      return;
    }

    if (connection.joinConfig.channelId !== channel.id) {
      await interaction.reply({
        content: `Riyad is connected to a different voice channel: <#${connection.joinConfig.channelId}>.`,
        ephemeral: true,
      });
      return;
    }

    connection.destroy();

    await interaction.reply({
      content: `Left voice channel <#${channel.id}>.`,
      ephemeral: true,
    });
  },
};
