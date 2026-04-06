import { SlashCommandBuilder } from 'discord.js';
import { requireAdmin } from './helpers.js';

export const nerdCommand = {
  data: new SlashCommandBuilder()
    .setName('nerd')
    .setDescription('Automatically react to a user with the nerd emoji')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('The user to react to')
        .setRequired(true),
    ),

  async execute({ interaction, store, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    const targetUser = interaction.options.getUser('user', true);
    store.setNerded(targetUser.id, true);

    await interaction.reply({
      content: `User <@${targetUser.id}> will now be auto-reacted to with ${config.nerdEmoji}.`,
      ephemeral: true,
    });
  },
};
