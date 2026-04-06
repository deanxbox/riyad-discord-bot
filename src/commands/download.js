import { SlashCommandBuilder } from 'discord.js';
import { requireAdmin } from './helpers.js';

export const downloadCommand = {
  data: new SlashCommandBuilder()
    .setName('download')
    .setDescription('Download messages of a user')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('The user to download messages from')
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName('message_count')
        .setDescription('The maximum number of messages to download')
        .setMinValue(1),
    ),

  async execute({ interaction, downloadJobs, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'This command only works inside a server.',
        ephemeral: true,
      });
      return;
    }

    const targetUser = interaction.options.getUser('user', true);
    const limit = interaction.options.getInteger('message_count') ?? null;

    await interaction.deferReply({ ephemeral: true });
    await downloadJobs.start({
      interaction,
      targetUserId: targetUser.id,
      limit,
    });
  },
};
