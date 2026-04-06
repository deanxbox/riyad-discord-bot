import { SlashCommandBuilder } from 'discord.js';
import { requireAdmin } from './helpers.js';

export const deleteCommand = {
  data: new SlashCommandBuilder()
    .setName('delete')
    .setDescription('Delete stored messages for a user')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('The user to delete messages from')
        .setRequired(true),
    ),

  async execute({ interaction, store, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    const targetUser = interaction.options.getUser('user', true);
    store.deleteUserData(targetUser.id);

    await interaction.reply({
      content: `Deleted stored messages for <@${targetUser.id}> and disabled tracking.`,
      ephemeral: true,
    });
  },
};
