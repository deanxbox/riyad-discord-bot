import { SlashCommandBuilder } from 'discord.js';
import { formatDateTime, requireAdmin } from './helpers.js';

export const randomLineCommand = {
  data: new SlashCommandBuilder()
    .setName('random-line')
    .setDescription('Show a random stored message for a user')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('The user to sample from')
        .setRequired(true),
    ),

  async execute({ interaction, store, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    const targetUser = interaction.options.getUser('user', true);
    const sample = store.getRandomMessageWithMetadata(targetUser.id);

    await interaction.reply({
      content: sample
        ? [
            `**Random stored line for <@${targetUser.id}>**`,
            `When: ${formatDateTime(sample.created_at)}`,
            sample.channel_id ? `Channel ID: ${sample.channel_id}` : null,
            '',
            sample.content,
          ].filter(Boolean).join('\n')
        : `No stored messages found for <@${targetUser.id}>.`,
      ephemeral: true,
    });
  },
};
