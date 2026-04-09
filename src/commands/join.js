import { SlashCommandBuilder } from 'discord.js';
import { requireAdmin } from './helpers.js';

export const joinCommand = {
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join a voice channel by name or ID')
    .addStringOption((option) =>
      option
        .setName('voice_channel')
        .setDescription('The voice channel name or ID to join')
        .setRequired(true),
    )
    .addBooleanOption((option) =>
      option
        .setName('persistence')
        .setDescription('Whether Riyad should rejoin if disconnected from that channel')
        .setRequired(false),
    ),

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

    const query = interaction.options.getString('voice_channel', true);
    const persistence = interaction.options.getBoolean('persistence') ?? true;
    const resolved = await voiceManager.resolveVoiceChannel(interaction.guild, query);

    if (resolved.ambiguous) {
      await interaction.reply({
        content: `Multiple voice channels matched that query: ${resolved.matches.map((channel) => `#${channel.name} (${channel.id})`).join(', ')}`,
        ephemeral: true,
      });
      return;
    }

    const channel = resolved.channel;

    if (!channel) {
      await interaction.reply({
        content: 'No matching voice channel was found by that name or ID.',
        ephemeral: true,
      });
      return;
    }

    try {
      await voiceManager.join(channel, { persistence });

      await interaction.reply({
        content: `Joined voice channel <#${channel.id}>.\nPersistence: ${persistence ? 'enabled' : 'disabled'}.`,
        ephemeral: true,
      });
    } catch (error) {
      console.error(`Failed to join voice channel ${channel.id}`, error);

      await interaction.reply({
        content: 'Failed to join that voice channel.',
        ephemeral: true,
      });
    }
  },
};
