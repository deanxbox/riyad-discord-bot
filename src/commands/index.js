import { Collection } from 'discord.js';
import { deleteCommand } from './delete.js';
import { downloadCommand } from './download.js';
import { downloadedListCommand } from './downloaded-list.js';
import { nerdCommand } from './nerd.js';
import { nerdListCommand } from './nerd-list.js';
import { replyChanceCommand } from './reply-chance.js';
import { sayCommand } from './say.js';
import { unNerdCommand } from './un-nerd.js';

const commands = [
  downloadCommand,
  deleteCommand,
  nerdCommand,
  unNerdCommand,
  replyChanceCommand,
  sayCommand,
  nerdListCommand,
  downloadedListCommand,
];

export const commandCollection = new Collection(commands.map((command) => [command.data.name, command]));
export const commandPayload = commands.map((command) => command.data.toJSON());
