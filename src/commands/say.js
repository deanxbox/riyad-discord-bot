import { SlashCommandBuilder } from 'discord.js';
import { requireAdmin } from './helpers.js';

export const sayCommand = {
  data: new SlashCommandBuilder()
    .setName('say')
    .setDescription('Make the bot say a message')
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription('The message to send')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('message_id')
        .setDescription('The message ID to reply to')
        .setRequired(false),
    ),

  async execute({ interaction, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    const message = interaction.options.getString('message', true);
    const messageId = interaction.options.getString('message_id');

    if (!interaction.channel || !interaction.channel.isTextBased()) {
      await interaction.reply({
        content: 'This command requires a text channel.',
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: `Saying: ${message}`,
      ephemeral: true,
    });

    if (messageId) {
      try {
        const referenceMessage = await interaction.channel.messages.fetch(messageId);
        await referenceMessage.reply(message);
        return;
      } catch {
        await interaction.channel.send(message);
        return;
      }
    }

    await interaction.channel.send(message);
  },
};
