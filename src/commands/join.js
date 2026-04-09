import { SlashCommandBuilder, ChannelType } from 'discord.js';
import { entersState, joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import { requireAdmin } from './helpers.js';

export const joinCommand = {
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join a voice channel by ID')
    .addStringOption((option) =>
      option
        .setName('voice_channel_id')
        .setDescription('The voice channel ID to join')
        .setRequired(true),
    ),

  async execute({ interaction, client, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    const voiceChannelId = interaction.options.getString('voice_channel_id', true);
    const channel = await client.channels.fetch(voiceChannelId).catch(() => null);

    if (!channel || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)) {
      await interaction.reply({
        content: 'That ID does not belong to a guild voice channel.',
        ephemeral: true,
      });
      return;
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

      await interaction.reply({
        content: `Joined voice channel <#${channel.id}>.`,
        ephemeral: true,
      });
    } catch (error) {
      connection.destroy();
      console.error(`Failed to join voice channel ${channel.id}`, error);

      await interaction.reply({
        content: 'Failed to join that voice channel.',
        ephemeral: true,
      });
    }
  },
};
