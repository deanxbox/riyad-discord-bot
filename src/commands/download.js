import { SlashCommandBuilder } from 'discord.js';
import { requireAdmin } from './helpers.js';
import { downloadUserHistory } from '../services/history-downloader.js';

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

  async execute({ interaction, store, config }) {
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

    const wasTracked = store.isTracked(targetUser.id);
    await interaction.editReply(
      wasTracked
        ? `Re-downloading stored messages for ${targetUser.username}.`
        : `Starting message download for ${targetUser.username}.`,
    );

    const result = await downloadUserHistory({
      guild: interaction.guild,
      targetUserId: targetUser.id,
      limit,
      store,
      onProgress: async ({ downloadedCount, processedChannels, totalChannels, channelName, channelCount, skipped }) => {
        const channelStatus = skipped
          ? `Skipped #${channelName} due to missing access or fetch errors.`
          : `Processed #${channelName}: ${channelCount} matching messages.`;

        await interaction.editReply(
          `Downloaded ${downloadedCount} messages for ${targetUser.username}.\n` +
            `${channelStatus}\n` +
            `Channels processed: ${processedChannels}/${totalChannels}`,
        );
      },
    });

    await interaction.editReply(
      `Finished downloading ${result.downloadedCount} messages for ${targetUser.username}.\n` +
        `Channels processed: ${result.processedChannels}/${result.totalChannels}`,
    );
  },
};
