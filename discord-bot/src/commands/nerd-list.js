import { SlashCommandBuilder } from 'discord.js';
import { requireAdmin, mentionList } from './helpers.js';

export const nerdListCommand = {
  data: new SlashCommandBuilder()
    .setName('nerd-list')
    .setDescription('Show the users who are nerded'),

  async execute({ interaction, store, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    await interaction.reply({
      content: mentionList(store.listNerdedUsers(), 'No users are currently nerded.', 'Nerd List'),
      ephemeral: true,
    });
  },
};
