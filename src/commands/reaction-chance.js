import { SlashCommandBuilder } from 'discord.js';
import { requireAdmin } from './helpers.js';

export const reactionChanceCommand = {
  data: new SlashCommandBuilder()
    .setName('reaction-chance')
    .setDescription('Show or update the special-role reaction mirror chance')
    .addIntegerOption((option) =>
      option.setName('denominator')
        .setDescription('Mirror chance is 1 in this many reactions (1–1000000)')
        .setMinValue(1)
        .setMaxValue(1000000),
    ),

  async execute({ interaction, store, config }) {
    if (!(await requireAdmin(interaction, config))) return;
    const denominator = interaction.options.getInteger('denominator');
    const value = denominator === null
      ? store.getReactionChanceDenominator()
      : store.setReactionChanceDenominator(denominator);
    await interaction.reply({
      content: `Special-role reaction mirror chance ${denominator === null ? 'is' : 'updated to'} 1 in ${value}.`,
      ephemeral: true,
    });
  },
};
