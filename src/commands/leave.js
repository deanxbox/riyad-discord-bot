import { SlashCommandBuilder } from 'discord.js';
import { requireAdmin } from './helpers.js';

export const leaveCommand = {
  data: new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave the voice channel Riyad is currently in'),

  async execute({ interaction, voiceManager, config }) {
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

    const currentChannelId = voiceManager.getCurrentChannelId(interaction.guildId);

    if (!currentChannelId) {
      await interaction.reply({
        content: 'Riyad is not connected to a voice channel in this guild.',
        ephemeral: true,
      });
      return;
    }

    voiceManager.leave(interaction.guildId);

    await interaction.reply({
      content: `Left voice channel <#${currentChannelId}>.`,
      ephemeral: true,
    });
  },
};
