import { AttachmentBuilder, SlashCommandBuilder } from 'discord.js';
import { requireAdmin } from './helpers.js';

export const exportUserCommand = {
  data: new SlashCommandBuilder()
    .setName('export-user')
    .setDescription('Export stored messages for a user')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('The user to export')
        .setRequired(true),
    ),

  async execute({ interaction, store, config }) {
    if (!(await requireAdmin(interaction, config))) {
      return;
    }

    const targetUser = interaction.options.getUser('user', true);
    const rows = store.exportUserMessages(targetUser.id);

    if (!rows.length) {
      await interaction.reply({
        content: `No stored messages found for <@${targetUser.id}>.`,
        ephemeral: true,
      });
      return;
    }

    const contents = rows
      .map((row) => `[${row.created_at ?? 'unknown-time'}] [channel:${row.channel_id ?? 'unknown'}] ${row.content}`)
      .join('\n');

    const attachment = new AttachmentBuilder(Buffer.from(contents, 'utf8'), {
      name: `${targetUser.id}-messages.txt`,
    });

    await interaction.reply({
      content: `Exported ${rows.length} stored messages for <@${targetUser.id}>.`,
      files: [attachment],
      ephemeral: true,
    });
  },
};
