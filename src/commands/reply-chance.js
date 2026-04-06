import { SlashCommandBuilder } from 'discord.js';
import { requireAdmin } from './helpers.js';

export const replyChanceCommand = {
  data: new SlashCommandBuilder()
    .setName('reply-chance')
    .setDescription('Show or update Riyad reply chance for tracked users')
    .addIntegerOption((option) =>
      option
        .setName('percent')
        .setDescription('Reply chance percentage for tracked users (0-100)')
        .setMinValue(0)
        .setMaxValue(100),
    ),

  async execute({ interaction, store, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    const percent = interaction.options.getInteger('percent');

    if (percent === null) {
      await interaction.reply({
        content:
          `Current tracked-user reply chance: ${store.getReplyChancePercent()}%.\n` +
          `<@${config.alwaysReplyUserId}> always gets a response when they mention or reply to Riyad.`,
        ephemeral: true,
      });
      return;
    }

    const nextPercent = store.setReplyChancePercent(percent);

    await interaction.reply({
      content:
        `Tracked-user reply chance updated to ${nextPercent}%.\n` +
        `<@${config.alwaysReplyUserId}> still always gets a response when they mention or reply to Riyad.`,
      ephemeral: true,
    });
  },
};
