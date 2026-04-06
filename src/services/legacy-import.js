import fs from 'node:fs';
import path from 'node:path';

function readLineSet(filePath) {
  if (!fs.existsSync(filePath)) {
    return new Set();
  }

  const contents = fs.readFileSync(filePath, 'utf8');

  return new Set(
    contents
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

function legacyTimestamp(index) {
  return new Date(Date.now() + index).toISOString();
}

export function importLegacyStoreIfPresent(store, rootDir) {
  if (store.hasLegacyImportCompleted()) {
    return { imported: false, reason: 'already-imported' };
  }

  const trackedUsersPath = path.join(rootDir, 'tracked_users.txt');
  const nerdedUsersPath = path.join(rootDir, 'nerded_users.txt');
  const userChatsDir = path.join(rootDir, 'user-chats');

  const trackedUsers = readLineSet(trackedUsersPath);
  const nerdedUsers = readLineSet(nerdedUsersPath);
  const hasChatFiles = fs.existsSync(userChatsDir) && fs.readdirSync(userChatsDir).some((name) => name.endsWith('.txt'));

  if (!trackedUsers.size && !nerdedUsers.size && !hasChatFiles) {
    store.markLegacyImportCompleted();
    return { imported: false, reason: 'nothing-to-import' };
  }

  for (const userId of trackedUsers) {
    store.setTracked(userId, true);
  }

  for (const userId of nerdedUsers) {
    store.setNerded(userId, true);
  }

  if (hasChatFiles) {
    const chatFiles = fs
      .readdirSync(userChatsDir)
      .filter((name) => name.endsWith('.txt'))
      .sort();

    for (const fileName of chatFiles) {
      const userId = path.basename(fileName, '.txt');
      const filePath = path.join(userChatsDir, fileName);
      const records = fs
        .readFileSync(filePath, 'utf8')
        .split(/\r?\n/u)
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0)
        .map((content, index) => ({
          messageId: `legacy-${userId}-${index + 1}`,
          userId,
          guildId: null,
          channelId: null,
          content,
          createdAt: legacyTimestamp(index),
        }));

      store.startUserDownload(userId);
      store.addDownloadedMessages(userId, records);
      store.finalizeUserDownload(userId);
    }
  }

  store.markLegacyImportCompleted();
  return { imported: true, reason: 'imported' };
}
