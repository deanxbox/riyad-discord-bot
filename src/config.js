import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function readRequiredEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const dataDir = path.resolve(rootDir, process.env.DATA_DIR?.trim() || 'data');

export const config = {
  rootDir,
  dataDir,
  dbPath: path.resolve(dataDir, process.env.DB_FILENAME?.trim() || 'bot.sqlite'),
  token: readRequiredEnv('DISCORD_TOKEN'),
  guildId: process.env.DISCORD_GUILD_ID?.trim() || null,
  specialUserId: process.env.SPECIAL_USER_ID?.trim() || '285021062578700289',
  specialRoleId: process.env.SPECIAL_ROLE_ID?.trim() || '1254166294656188426',
  alwaysReplyUserId: process.env.ALWAYS_REPLY_USER_ID?.trim() || '256876746861707264',
  nerdEmoji: process.env.NERD_EMOJI?.trim() || '\u{1F913}',
  defaultReplyChancePercent: Number(process.env.DEFAULT_REPLY_CHANCE_PERCENT?.trim() || 4),
  reactionChanceDenominator: 6,
};
