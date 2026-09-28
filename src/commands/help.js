import { SlashCommandBuilder } from 'discord.js';
import { commandPayload } from './index.js';

export const helpCommand = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('List available slash commands'),

  async execute({ interaction }) {
    const lines = commandPayload
      .map(({ name, description }) => `/${name} — ${description}`)
      .sort((a, b) => a.localeCompare(b));
    await interaction.reply({ content: lines.join('\n'), ephemeral: true });
  },
};
