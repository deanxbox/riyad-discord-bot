import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function nowIso() {
  return new Date().toISOString();
}

export class DataStore {
  constructor(dbPath, { defaultReplyChancePercent = 4 } = {}) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.db = new DatabaseSync(dbPath);
    this.trackedUsers = new Set();
    this.nerdedUsers = new Set();
    this.messageCounts = new Map();
    this.replyChancePercent = defaultReplyChancePercent;

    this.initialize();
    this.runMigrations();
    this.prepareStatements();
    this.loadCaches();
    this.ensureReplyChanceMetadata(defaultReplyChancePercent);
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
        reply_chance_override INTEGER,
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

      CREATE TABLE IF NOT EXISTS download_staging_messages (
        job_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        guild_id TEXT,
        channel_id TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (job_id, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_download_staging_messages_job_id
      ON download_staging_messages (job_id);

      CREATE TABLE IF NOT EXISTS trivia_scores (
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        score INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, guild_id)
      );

      CREATE TABLE IF NOT EXISTS trivia_active (
        guild_id TEXT PRIMARY KEY,
        correct_user_id TEXT NOT NULL,
        message_content TEXT NOT NULL,
        option_user_ids TEXT NOT NULL,
        answered_user_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
    `);

    this.db.exec(`
      DELETE FROM download_staging_messages;
    `);
  }

  runMigrations() {
    this.addColumnIfMissing('user_settings', 'reply_chance_override', 'INTEGER');
  }

  prepareStatements() {
    this.ensureUserStmt = this.db.prepare(`
      INSERT INTO user_settings (user_id, tracked, nerded, message_count, updated_at)
      VALUES (?, 0, 0, 0, ?)
      ON CONFLICT(user_id) DO NOTHING
    `);

    this.userSettingsStmt = this.db.prepare(`
      SELECT user_id, tracked, nerded, reply_chance_override, message_count, last_downloaded_at, updated_at
      FROM user_settings
    `);

    this.userSummaryStmt = this.db.prepare(`
      SELECT user_id, tracked, nerded, reply_chance_override, message_count, last_downloaded_at, updated_at
      FROM user_settings
      WHERE user_id = ?
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

    this.updateReplyChanceOverrideStmt = this.db.prepare(`
      UPDATE user_settings
      SET reply_chance_override = ?, updated_at = ?
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

    this.insertStagingMessageStmt = this.db.prepare(`
      INSERT OR IGNORE INTO download_staging_messages (
        job_id,
        message_id,
        user_id,
        guild_id,
        channel_id,
        content,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.deleteStagingMessagesStmt = this.db.prepare(`
      DELETE FROM download_staging_messages
      WHERE job_id = ?
    `);

    this.countStagingMessagesStmt = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM download_staging_messages
      WHERE job_id = ?
    `);

    this.promoteStagingMessagesStmt = this.db.prepare(`
      INSERT OR REPLACE INTO user_messages (
        message_id,
        user_id,
        guild_id,
        channel_id,
        content,
        created_at
      )
      SELECT
        message_id,
        user_id,
        guild_id,
        channel_id,
        content,
        created_at
      FROM download_staging_messages
      WHERE job_id = ?
    `);

    this.randomMessageStmt = this.db.prepare(`
      SELECT content
      FROM user_messages
      WHERE user_id = ? AND LENGTH(TRIM(content)) > 0
      ORDER BY RANDOM()
      LIMIT 1
    `);

    this.randomMessageWithMetadataStmt = this.db.prepare(`
      SELECT content, created_at, channel_id
      FROM user_messages
      WHERE user_id = ? AND LENGTH(TRIM(content)) > 0
      ORDER BY RANDOM()
      LIMIT 1
    `);

    this.exportUserMessagesStmt = this.db.prepare(`
      SELECT content, created_at, channel_id, guild_id, message_id
      FROM user_messages
      WHERE user_id = ?
      ORDER BY created_at ASC, message_id ASC
    `);

    this.totalStoredMessagesStmt = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM user_messages
    `);

    this.insertTriviaActiveStmt = this.db.prepare(`
      INSERT OR REPLACE INTO trivia_active (guild_id, correct_user_id, message_content, option_user_ids, answered_user_ids, created_at)
      VALUES (?, ?, ?, ?, '[]', ?)
    `);

    this.selectTriviaActiveStmt = this.db.prepare(`
      SELECT guild_id, correct_user_id, message_content, option_user_ids, answered_user_ids, created_at
      FROM trivia_active
      WHERE guild_id = ?
    `);

    this.deleteTriviaActiveStmt = this.db.prepare(`
      DELETE FROM trivia_active WHERE guild_id = ?
    `);

    this.updateTriviaAnsweredStmt = this.db.prepare(`
      UPDATE trivia_active SET answered_user_ids = ? WHERE guild_id = ?
    `);

    this.upsertTriviaScoreStmt = this.db.prepare(`
      INSERT INTO trivia_scores (user_id, guild_id, score)
      VALUES (?, ?, 1)
      ON CONFLICT(user_id, guild_id) DO UPDATE SET score = score + 1
    `);

    this.selectTriviaLeaderboardStmt = this.db.prepare(`
      SELECT user_id, score
      FROM trivia_scores
      WHERE guild_id = ?
      ORDER BY score DESC
      LIMIT ?
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

    const storedReplyChance = Number(this.getMetadata('reply_chance_percent'));

    if (Number.isFinite(storedReplyChance)) {
      this.replyChancePercent = clampPercent(storedReplyChance);
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

  addColumnIfMissing(tableName, columnName, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all();
    const hasColumn = columns.some((column) => column.name === columnName);

    if (!hasColumn) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
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

  ensureReplyChanceMetadata(defaultReplyChancePercent) {
    if (this.getMetadata('reply_chance_percent') === null) {
      this.setReplyChancePercent(defaultReplyChancePercent);
    }
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

  getReplyChancePercent() {
    return this.replyChancePercent;
  }

  getReplyChanceOverride(userId) {
    const row = this.userSummaryStmt.get(String(userId));

    if (!row || row.reply_chance_override === null || row.reply_chance_override === undefined) {
      return null;
    }

    return clampPercent(row.reply_chance_override);
  }

  getEffectiveReplyChancePercent(userId) {
    const override = this.getReplyChanceOverride(userId);
    return override === null ? this.replyChancePercent : override;
  }

  setReplyChancePercent(percent) {
    const normalizedPercent = clampPercent(percent);
    this.replyChancePercent = normalizedPercent;
    this.setMetadata('reply_chance_percent', String(normalizedPercent));
    return normalizedPercent;
  }

  setUserReplyChanceOverride(userId, percent) {
    const normalizedUserId = String(userId);
    const normalizedPercent = percent === null ? null : clampPercent(percent);

    this.transaction(() => {
      this.ensureUser(normalizedUserId);
      this.updateReplyChanceOverrideStmt.run(normalizedPercent, nowIso(), normalizedUserId);
    });

    return normalizedPercent;
  }

  listTrackedUsers() {
    return [...this.trackedUsers].sort();
  }

  listNerdedUsers() {
    return [...this.nerdedUsers].sort();
  }

  getTrackedUsersCount() {
    return this.trackedUsers.size;
  }

  getNerdedUsersCount() {
    return this.nerdedUsers.size;
  }

  getTotalStoredMessages() {
    return Number(this.totalStoredMessagesStmt.get()?.count || 0);
  }

  getUserSummary(userId) {
    const normalizedUserId = String(userId);
    const row = this.userSummaryStmt.get(normalizedUserId);

    if (!row) {
      return {
        userId: normalizedUserId,
        tracked: false,
        nerded: false,
        replyChanceOverride: null,
        effectiveReplyChancePercent: this.replyChancePercent,
        messageCount: 0,
        lastDownloadedAt: null,
        updatedAt: null,
      };
    }

    const replyChanceOverride =
      row.reply_chance_override === null || row.reply_chance_override === undefined
        ? null
        : clampPercent(row.reply_chance_override);

    return {
      userId: normalizedUserId,
      tracked: Boolean(row.tracked),
      nerded: Boolean(row.nerded),
      replyChanceOverride,
      effectiveReplyChancePercent: replyChanceOverride === null ? this.replyChancePercent : replyChanceOverride,
      messageCount: Number(row.message_count) || 0,
      lastDownloadedAt: row.last_downloaded_at ?? null,
      updatedAt: row.updated_at ?? null,
    };
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

  beginStagedUserDownload(jobId, userId) {
    const normalizedJobId = String(jobId);
    const normalizedUserId = String(userId);

    this.transaction(() => {
      this.ensureUser(normalizedUserId);
      this.deleteStagingMessagesStmt.run(normalizedJobId);
    });
  }

  addStagedDownloadedMessages(jobId, userId, messages) {
    if (!messages.length) {
      return 0;
    }

    const normalizedJobId = String(jobId);
    const normalizedUserId = String(userId);
    let insertedCount = 0;

    this.transaction(() => {
      this.ensureUser(normalizedUserId);

      for (const message of messages) {
        const result = this.insertStagingMessageStmt.run(
          normalizedJobId,
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

    return insertedCount;
  }

  getStagedDownloadCount(jobId) {
    return Number(this.countStagingMessagesStmt.get(String(jobId))?.count || 0);
  }

  commitStagedUserDownload(jobId, userId) {
    const normalizedJobId = String(jobId);
    const normalizedUserId = String(userId);
    const nextCount = this.getStagedDownloadCount(normalizedJobId);

    this.transaction(() => {
      this.ensureUser(normalizedUserId);
      this.deleteUserMessagesStmt.run(normalizedUserId);
      this.promoteStagingMessagesStmt.run(normalizedJobId);
      this.updateTrackedStmt.run(1, nowIso(), normalizedUserId);
      this.updateMessageCountStmt.run(nextCount, nowIso(), nowIso(), normalizedUserId);
      this.deleteStagingMessagesStmt.run(normalizedJobId);
    });

    this.trackedUsers.add(normalizedUserId);
    this.messageCounts.set(normalizedUserId, nextCount);

    return nextCount;
  }

  discardStagedUserDownload(jobId) {
    this.deleteStagingMessagesStmt.run(String(jobId));
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

  getRandomMessageWithMetadata(userId) {
    return this.randomMessageWithMetadataStmt.get(String(userId)) ?? null;
  }

  exportUserMessages(userId) {
    return this.exportUserMessagesStmt.all(String(userId));
  }

  setActiveTriviaQuestion(guildId, { correctUserId, messageContent, optionUserIds }) {
    this.insertTriviaActiveStmt.run(
      String(guildId),
      String(correctUserId),
      messageContent,
      JSON.stringify(optionUserIds.map(String)),
      nowIso(),
    );
  }

  getActiveTriviaQuestion(guildId) {
    return this.selectTriviaActiveStmt.get(String(guildId)) ?? null;
  }

  clearActiveTriviaQuestion(guildId) {
    this.deleteTriviaActiveStmt.run(String(guildId));
  }

  // Atomically registers a user's answer attempt.
  // Returns { status: 'no_question' | 'already_answered' | 'ok', question? }
  triviaAttempt(guildId, userId) {
    const normalizedGuildId = String(guildId);
    const normalizedUserId = String(userId);

    return this.transaction(() => {
      const question = this.selectTriviaActiveStmt.get(normalizedGuildId);
      if (!question) return { status: 'no_question' };

      const answeredIds = JSON.parse(question.answered_user_ids);
      if (answeredIds.includes(normalizedUserId)) return { status: 'already_answered' };

      answeredIds.push(normalizedUserId);
      this.updateTriviaAnsweredStmt.run(JSON.stringify(answeredIds), normalizedGuildId);

      return { status: 'ok', question };
    });
  }

  triviaIncrementScore(userId, guildId) {
    this.upsertTriviaScoreStmt.run(String(userId), String(guildId));
  }

  triviaGetLeaderboard(guildId, limit = 10) {
    return this.selectTriviaLeaderboardStmt.all(String(guildId), limit);
  }
}

function clampPercent(value) {
  const normalizedValue = Number(value);

  if (!Number.isFinite(normalizedValue)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(normalizedValue)));
}
