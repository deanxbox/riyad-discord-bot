import { SlashCommandBuilder } from 'discord.js';
import { requireAdmin } from './helpers.js';

export const nextReplyCommand = {
  data: new SlashCommandBuilder()
    .setName('next-reply')
    .setDescription('Queue the next Riyad auto-reply')
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription('The reply message Riyad should use next')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('user_id')
        .setDescription('Optional user ID that this queued reply is reserved for')
        .setRequired(false),
    ),

  async execute({ interaction, nextReplyQueue, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    const message = interaction.options.getString('message', true);
    const userId = interaction.options.getString('user_id');

    const entry = nextReplyQueue.enqueue({
      message,
      targetUserId: userId ?? null,
      createdByUserId: interaction.user.id,
    });

    await interaction.reply({
      content: userId
        ? `Queued the next Riyad reply for <@${userId}>.\n\n${entry.message}`
        : `Queued the next Riyad reply for the next qualifying auto-response.\n\n${entry.message}`,
      ephemeral: true,
    });
  },
};
