import { SlashCommandBuilder } from 'discord.js';
import { requireAdmin } from './helpers.js';

export const nextReplyCommand = {
  data: new SlashCommandBuilder()
    .setName('next-reply')
    .setDescription('Queue the next Riyad auto-reply for any user or a selected user')
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription('The reply message Riyad should use next')
        .setRequired(true),
    )
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Optional user to reserve this reply for (takes priority over user_id)')
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('user_id')
        .setDescription('Fallback Discord user ID when no user is selected (17–20 digits)')
        .setRequired(false),
    ),

  async execute({ interaction, nextReplyQueue, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    const message = interaction.options.getString('message', true);
    const userId = interaction.options.getUser('user')?.id ?? interaction.options.getString('user_id') ?? null;
    if (userId !== null && !/^\d{17,20}$/.test(userId)) {
      await interaction.reply({ content: 'Enter a valid Discord user ID (17–20 digits).', ephemeral: true });
      return;
    }

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
