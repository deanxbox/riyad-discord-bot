import { SlashCommandBuilder } from 'discord.js';
import { requireAdmin, mentionList } from './helpers.js';

export const downloadedListCommand = {
  data: new SlashCommandBuilder()
    .setName('downloaded-list')
    .setDescription('Show the users whose messages are stored'),

  async execute({ interaction, store, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    await interaction.reply({
      content: mentionList(store.listTrackedUsers(), 'No users have stored messages.', 'Downloaded List'),
      ephemeral: true,
    });
  },
};
