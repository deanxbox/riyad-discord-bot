import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

function nowIso() {
  return new Date().toISOString();
}

export class DataStore {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.trackedUsers = new Set();
    this.nerdedUsers = new Set();
    this.messageCounts = new Map();

    this.initialize();
    this.prepareStatements();
    this.loadCaches();
  }

  initialize() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY,
        tracked INTEGER NOT NULL DEFAULT 0,
        nerded INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_downloaded_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_messages (
        message_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        guild_id TEXT,
        channel_id TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES user_settings(user_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_user_messages_user_id
      ON user_messages (user_id);
    `);
  }

  prepareStatements() {
    this.ensureUserStmt = this.db.prepare(`
      INSERT INTO user_settings (user_id, tracked, nerded, message_count, updated_at)
      VALUES (?, 0, 0, 0, ?)
      ON CONFLICT(user_id) DO NOTHING
    `);

    this.userSettingsStmt = this.db.prepare(`
      SELECT user_id, tracked, nerded, message_count
      FROM user_settings
    `);

    this.upsertMetadataStmt = this.db.prepare(`
      INSERT INTO metadata (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    this.selectMetadataStmt = this.db.prepare(`
      SELECT value
      FROM metadata
      WHERE key = ?
    `);

    this.updateTrackedStmt = this.db.prepare(`
      UPDATE user_settings
      SET tracked = ?, updated_at = ?
      WHERE user_id = ?
    `);

    this.updateNerdedStmt = this.db.prepare(`
      UPDATE user_settings
      SET nerded = ?, updated_at = ?
      WHERE user_id = ?
    `);

    this.updateMessageCountStmt = this.db.prepare(`
      UPDATE user_settings
      SET message_count = ?, updated_at = ?, last_downloaded_at = COALESCE(?, last_downloaded_at)
      WHERE user_id = ?
    `);

    this.deleteUserMessagesStmt = this.db.prepare(`
      DELETE FROM user_messages
      WHERE user_id = ?
    `);

    this.insertMessageStmt = this.db.prepare(`
      INSERT OR IGNORE INTO user_messages (
        message_id,
        user_id,
        guild_id,
        channel_id,
        content,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.randomMessageStmt = this.db.prepare(`
      SELECT content
      FROM user_messages
      WHERE user_id = ? AND LENGTH(TRIM(content)) > 0
      ORDER BY RANDOM()
      LIMIT 1
    `);
  }

  loadCaches() {
    const rows = this.userSettingsStmt.all();

    this.trackedUsers.clear();
    this.nerdedUsers.clear();
    this.messageCounts.clear();

    for (const row of rows) {
      const userId = String(row.user_id);

      if (row.tracked) {
        this.trackedUsers.add(userId);
      }

      if (row.nerded) {
        this.nerdedUsers.add(userId);
      }

      this.messageCounts.set(userId, Number(row.message_count) || 0);
    }
  }

  close() {
    this.db.close();
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');

    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  hasLegacyImportCompleted() {
    return this.getMetadata('legacy_import_completed') === '1';
  }

  markLegacyImportCompleted() {
    this.setMetadata('legacy_import_completed', '1');
  }

  getMetadata(key) {
    return this.selectMetadataStmt.get(key)?.value ?? null;
  }

  setMetadata(key, value) {
    this.upsertMetadataStmt.run(key, value);
  }

  ensureUser(userId) {
    this.ensureUserStmt.run(String(userId), nowIso());
  }

  isTracked(userId) {
    return this.trackedUsers.has(String(userId));
  }

  isNerded(userId) {
    return this.nerdedUsers.has(String(userId));
  }

  getMessageCount(userId) {
    return this.messageCounts.get(String(userId)) || 0;
  }

  listTrackedUsers() {
    return [...this.trackedUsers].sort();
  }

  listNerdedUsers() {
    return [...this.nerdedUsers].sort();
  }

  setTracked(userId, tracked) {
    const normalizedUserId = String(userId);

    this.transaction(() => {
      this.ensureUser(normalizedUserId);
      this.updateTrackedStmt.run(tracked ? 1 : 0, nowIso(), normalizedUserId);
    });

    if (tracked) {
      this.trackedUsers.add(normalizedUserId);
    } else {
      this.trackedUsers.delete(normalizedUserId);
    }

    if (!this.messageCounts.has(normalizedUserId)) {
      this.messageCounts.set(normalizedUserId, 0);
    }
  }

  setNerded(userId, nerded) {
    const normalizedUserId = String(userId);

    this.transaction(() => {
      this.ensureUser(normalizedUserId);
      this.updateNerdedStmt.run(nerded ? 1 : 0, nowIso(), normalizedUserId);
    });

    if (nerded) {
      this.nerdedUsers.add(normalizedUserId);
    } else {
      this.nerdedUsers.delete(normalizedUserId);
    }

    if (!this.messageCounts.has(normalizedUserId)) {
      this.messageCounts.set(normalizedUserId, 0);
    }
  }

  startUserDownload(userId) {
    const normalizedUserId = String(userId);

    this.transaction(() => {
      this.ensureUser(normalizedUserId);
      this.deleteUserMessagesStmt.run(normalizedUserId);
      this.updateTrackedStmt.run(1, nowIso(), normalizedUserId);
      this.updateMessageCountStmt.run(0, nowIso(), null, normalizedUserId);
    });

    this.trackedUsers.add(normalizedUserId);
    this.messageCounts.set(normalizedUserId, 0);
  }

  addDownloadedMessages(userId, messages) {
    if (!messages.length) {
      return;
    }

    const normalizedUserId = String(userId);
    let insertedCount = 0;

    this.transaction(() => {
      this.ensureUser(normalizedUserId);

      for (const message of messages) {
        const result = this.insertMessageStmt.run(
          message.messageId,
          normalizedUserId,
          message.guildId,
          message.channelId,
          message.content,
          message.createdAt,
        );

        insertedCount += result.changes;
      }
    });

    if (insertedCount > 0) {
      const nextCount = this.getMessageCount(normalizedUserId) + insertedCount;
      this.messageCounts.set(normalizedUserId, nextCount);
      this.updateMessageCountStmt.run(nextCount, nowIso(), null, normalizedUserId);
    }
  }

  finalizeUserDownload(userId) {
    const normalizedUserId = String(userId);
    this.ensureUser(normalizedUserId);
    this.updateMessageCountStmt.run(
      this.getMessageCount(normalizedUserId),
      nowIso(),
      nowIso(),
      normalizedUserId,
    );
  }

  deleteUserData(userId) {
    const normalizedUserId = String(userId);

    this.transaction(() => {
      this.ensureUser(normalizedUserId);
      this.deleteUserMessagesStmt.run(normalizedUserId);
      this.updateTrackedStmt.run(0, nowIso(), normalizedUserId);
      this.updateMessageCountStmt.run(0, nowIso(), null, normalizedUserId);
    });

    this.trackedUsers.delete(normalizedUserId);
    this.messageCounts.set(normalizedUserId, 0);
  }

  appendLiveMessage(message) {
    const normalizedUserId = String(message.userId);

    this.ensureUser(normalizedUserId);

    const result = this.insertMessageStmt.run(
      message.messageId,
      normalizedUserId,
      message.guildId,
      message.channelId,
      message.content,
      message.createdAt,
    );

    if (result.changes > 0) {
      const nextCount = this.getMessageCount(normalizedUserId) + 1;
      this.messageCounts.set(normalizedUserId, nextCount);
      this.updateMessageCountStmt.run(nextCount, nowIso(), null, normalizedUserId);
    }
  }

  getRandomMessage(userId) {
    return this.randomMessageStmt.get(String(userId))?.content ?? null;
  }
}
