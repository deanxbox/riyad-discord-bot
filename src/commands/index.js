import { Collection } from 'discord.js';
import { deleteCommand } from './delete.js';
import { scoreboardCommand } from './scoreboard.js';
import { triviaCommand } from './trivia.js';
import { downloadCancelCommand } from './download-cancel.js';
import { downloadRefreshAllCommand } from './download-refresh-all.js';
import { downloadStatusCommand } from './download-status.js';
import { downloadCommand } from './download.js';
import { downloadedListCommand } from './downloaded-list.js';
import { exportUserCommand } from './export-user.js';
import { joinCommand } from './join.js';
import { leaveCommand } from './leave.js';
import { nextReplyCommand } from './next-reply.js';
import { nerdCommand } from './nerd.js';
import { nerdListCommand } from './nerd-list.js';
import { replyChanceCommand } from './reply-chance.js';
import { replyModeCommand } from './reply-mode.js';
import { randomLineCommand } from './random-line.js';
import { sayCommand } from './say.js';
import { statsCommand } from './stats.js';
import { testReplyCommand } from './test-reply.js';
import { trackedUserCommand } from './tracked-user.js';
import { unNerdCommand } from './un-nerd.js';

const commands = [
  downloadCommand,
  downloadStatusCommand,
  downloadCancelCommand,
  downloadRefreshAllCommand,
  deleteCommand,
  trackedUserCommand,
  nerdCommand,
  unNerdCommand,
  replyChanceCommand,
  replyModeCommand,
  exportUserCommand,
  randomLineCommand,
  statsCommand,
  testReplyCommand,
  nextReplyCommand,
  joinCommand,
  leaveCommand,
  sayCommand,
  nerdListCommand,
  downloadedListCommand,
  triviaCommand,
  scoreboardCommand,
];

export const commandCollection = new Collection(commands.map((command) => [command.data.name, command]));
export const commandPayload = commands.map((command) => command.data.toJSON());
