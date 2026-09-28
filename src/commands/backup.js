import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AttachmentBuilder, SlashCommandBuilder } from 'discord.js';
import { requireAdmin } from './helpers.js';

export const backupCommand = {
  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Download a consistent SQLite database backup'),

  async execute({ interaction, store, config }) {
    if (!(await requireAdmin(interaction, config))) return;
    await interaction.deferReply({ ephemeral: true });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'riyad-backup-'));
    const filename = path.join(dir, 'bot.sqlite');
    try {
      store.backupTo(filename);
      await interaction.editReply({
        content: 'SQLite backup:',
        files: [new AttachmentBuilder(filename, { name: 'bot-backup.sqlite' })],
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
};
