import { SlashCommandBuilder } from 'discord.js';
import { requireAdmin } from './helpers.js';

export const unNerdCommand = {
  data: new SlashCommandBuilder()
    .setName('un-nerd')
    .setDescription('Stop automatically reacting to a user with the nerd emoji')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('The user to stop reacting to')
        .setRequired(true),
    ),

  async execute({ interaction, store, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    const targetUser = interaction.options.getUser('user', true);
    const wasNerded = store.isNerded(targetUser.id);

    if (!wasNerded) {
      await interaction.reply({
        content: `User <@${targetUser.id}> is not currently auto-reacted to with ${config.nerdEmoji}.`,
        ephemeral: true,
      });
      return;
    }

    store.setNerded(targetUser.id, false);

    await interaction.reply({
      content: `User <@${targetUser.id}> will no longer be auto-reacted to with ${config.nerdEmoji}.`,
      ephemeral: true,
    });
  },
};
