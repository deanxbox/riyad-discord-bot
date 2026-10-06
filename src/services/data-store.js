import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_TRIVIA_LIFETIME_MS = 60 * 1000;
export const TRIVIA_MIN_RATIO_GUESSES = 10;

function nowIso() {
  return new Date().toISOString();
}

export function isTriviaExpired(question, now = Date.now(), lifetimeMs = DEFAULT_TRIVIA_LIFETIME_MS) {
  return now - Date.parse(question.created_at) > lifetimeMs;
}

export class DataStore extends EventEmitter {
  constructor(dbPath, {
    defaultReplyChancePercent = 4,
    reactionChanceDenominator = 6,
    alwaysReplyUserId = '256876746861707264',
    nerdEmoji = '🤓',
    triviaTimeoutSeconds = 60,
    triviaBonusSeconds = 1.5,
  } = {}) {
    super();
    this.defaultTriviaBonusSeconds = Number.isFinite(triviaBonusSeconds) && triviaBonusSeconds >= 0 && triviaBonusSeconds <= 60 ? triviaBonusSeconds : 1.5;
    this.defaultTriviaTimeoutSeconds = Number.isFinite(triviaTimeoutSeconds) && triviaTimeoutSeconds >= 5 && triviaTimeoutSeconds <= 3600 ? triviaTimeoutSeconds : DEFAULT_TRIVIA_LIFETIME_MS / 1000;
    this.on('change', change => { if (change?.type === 'user') this.messageSourcesCache = null; });
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.db = new DatabaseSync(dbPath);
    this.trackedUsers = new Set();
    this.nerdedUsers = new Set();
    this.messageCounts = new Map();
    this.replyChancePercent = defaultReplyChancePercent;
    this.defaultReactionChanceDenominator = reactionChanceDenominator;
    this.defaultAlwaysReplyUserId = alwaysReplyUserId;
    this.defaultNerdEmoji = nerdEmoji;

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
        media_skipped INTEGER NOT NULL DEFAULT 0,
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

      CREATE INDEX IF NOT EXISTS idx_user_messages_user_guild
      ON user_messages (user_id, guild_id);

      CREATE INDEX IF NOT EXISTS idx_user_messages_unassigned_channel
      ON user_messages (channel_id) WHERE guild_id IS NULL AND channel_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_user_messages_unassigned_user
      ON user_messages (user_id) WHERE guild_id IS NULL;

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

    // Staged rows of unfinished jobs are kept so they can resume after a restart.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS download_jobs (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        requested_by TEXT,
        limit_count INTEGER,
        channel_ids TEXT NOT NULL,
        state TEXT
      );
      DELETE FROM download_staging_messages WHERE job_id NOT IN (SELECT id FROM download_jobs);
    `);
  }

  runMigrations() {
    this.addColumnIfMissing('trivia_active', 'guesses', "TEXT NOT NULL DEFAULT '[]'");
    for (const column of ['wins', 'losses', 'first_guesses', 'streak', 'best_win_streak', 'best_loss_streak']) {
      this.addColumnIfMissing('trivia_scores', column, 'INTEGER NOT NULL DEFAULT 0'); // streak: +n win run, -n loss run
    }
    this.addColumnIfMissing('user_settings', 'reply_chance_override', 'INTEGER');
    this.addColumnIfMissing('user_settings', 'media_skipped', 'INTEGER NOT NULL DEFAULT 0');
    this.backfillMessageGuilds();
  }

  // Earlier downloads stored NULL guild_id. The per-user download checkpoint ("guildId:messageId")
  // records the guild that was searched, so use it for non-legacy rows only.
  backfillMessageGuilds() {
    const rows = this.db.prepare("SELECT key, value FROM metadata WHERE key LIKE 'download_checkpoint:%'").all();
    const update = this.db.prepare("UPDATE user_messages SET guild_id = ? WHERE user_id = ? AND guild_id IS NULL AND message_id NOT LIKE 'legacy-%'");
    this.transaction(() => {
      for (const { key, value } of rows) {
        const [guildId] = String(value).split(':');
        if (/^\d{17,20}$/.test(guildId)) update.run(guildId, key.slice('download_checkpoint:'.length));
      }
    });
  }

  prepareStatements() {
    this.ensureUserStmt = this.db.prepare(`
      INSERT INTO user_settings (user_id, tracked, nerded, message_count, updated_at)
      VALUES (?, 0, 0, 0, ?)
      ON CONFLICT(user_id) DO NOTHING
    `);

    this.userSettingsStmt = this.db.prepare(`
      SELECT user_id, tracked, nerded, reply_chance_override, message_count, media_skipped, last_downloaded_at, updated_at
      FROM user_settings
    `);

    this.userSummaryStmt = this.db.prepare(`
      SELECT user_id, tracked, nerded, reply_chance_override, message_count, media_skipped, last_downloaded_at, updated_at
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

    this.deleteMetadataStmt = this.db.prepare('DELETE FROM metadata WHERE key = ?');

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

    this.incrementMediaSkippedStmt = this.db.prepare(`
      UPDATE user_settings
      SET media_skipped = media_skipped + 1, updated_at = ?
      WHERE user_id = ?
    `);

    this.replaceMediaSkippedStmt = this.db.prepare(`
      UPDATE user_settings
      SET media_skipped = ?
      WHERE user_id = ?
    `);

    this.deleteUserMessagesStmt = this.db.prepare(`
      DELETE FROM user_messages
      WHERE user_id = ?
    `);
    this.deleteUserSettingsStmt = this.db.prepare('DELETE FROM user_settings WHERE user_id = ?');
    this.deleteUserStagingStmt = this.db.prepare('DELETE FROM download_staging_messages WHERE user_id = ?');
    this.deleteUserTriviaStmt = this.db.prepare('DELETE FROM trivia_scores WHERE user_id = ?');

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

    this.promoteNewStagingMessagesStmt = this.db.prepare(`
      INSERT OR IGNORE INTO user_messages (message_id, user_id, guild_id, channel_id, content, created_at)
      SELECT message_id, user_id, guild_id, channel_id, content, created_at
      FROM download_staging_messages WHERE job_id = ?
    `);

    // ORDER BY RANDOM() sorts every row for the user and blocks the event loop. A random rowid is
    // biased (it favours rows after gaps), so pick a uniform OFFSET into the user's index instead.
    this.userMessageCountStmt = this.db.prepare('SELECT COUNT(*) AS count FROM user_messages WHERE user_id = ?');
    this.messageAtOffsetStmt = this.db.prepare(`
      SELECT content, created_at, channel_id
      FROM user_messages
      WHERE user_id = ?
      ORDER BY rowid
      LIMIT 1 OFFSET ?
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

    this.totalMediaSkippedStmt = this.db.prepare(`
      SELECT COALESCE(SUM(media_skipped), 0) AS count
      FROM user_settings
    `);

    this.insertTriviaActiveStmt = this.db.prepare(`
      INSERT OR REPLACE INTO trivia_active (guild_id, correct_user_id, message_content, option_user_ids, answered_user_ids, created_at)
      VALUES (?, ?, ?, ?, '[]', ?)
    `);

    this.selectTriviaActiveStmt = this.db.prepare(`
      SELECT guild_id, correct_user_id, message_content, option_user_ids, answered_user_ids, guesses, created_at
      FROM trivia_active
      WHERE guild_id = ?
    `);

    this.deleteTriviaActiveStmt = this.db.prepare(`
      DELETE FROM trivia_active WHERE guild_id = ?
    `);

    this.updateTriviaAnsweredStmt = this.db.prepare(`
      UPDATE trivia_active SET answered_user_ids = ?, guesses = ? WHERE guild_id = ?
    `);

    this.upsertTriviaScoreStmt = this.db.prepare(`
      INSERT INTO trivia_scores (user_id, guild_id, score)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, guild_id) DO UPDATE SET score = score + excluded.score
    `);

    this.selectTriviaLeaderboardStmt = this.db.prepare(`
      SELECT user_id, score, wins, losses, first_guesses, streak, best_win_streak, best_loss_streak
      FROM trivia_scores
      WHERE guild_id = ?
      ORDER BY score DESC, user_id ASC
      LIMIT ?
    `);

    this.selectTriviaRatioLeaderboardStmt = this.db.prepare(`
      SELECT user_id, score, wins, losses, first_guesses, streak, best_win_streak, best_loss_streak
      FROM trivia_scores
      WHERE guild_id = ? AND wins + losses >= ?
      ORDER BY CAST(wins AS REAL) / MAX(losses, 1) DESC, wins DESC, user_id ASC
      LIMIT ?
    `);

    this.selectTriviaStatStmt = this.db.prepare('SELECT streak, best_win_streak, best_loss_streak FROM trivia_scores WHERE user_id = ? AND guild_id = ?');
    this.upsertTriviaStatStmt = this.db.prepare(`
      INSERT INTO trivia_scores (user_id, guild_id, score, wins, losses, first_guesses, streak, best_win_streak, best_loss_streak)
      VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, guild_id) DO UPDATE SET
        wins = wins + excluded.wins, losses = losses + excluded.losses, first_guesses = first_guesses + excluded.first_guesses,
        streak = excluded.streak, best_win_streak = excluded.best_win_streak, best_loss_streak = excluded.best_loss_streak
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

  backupTo(destination) {
    // VACUUM INTO makes a consistent SQLite snapshot, including uncheckpointed WAL changes.
    this.db.prepare('VACUUM INTO ?').run(destination);
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

  getMetadata(key) {
    return this.selectMetadataStmt.get(key)?.value ?? null;
  }

  setMetadata(key, value) {
    this.upsertMetadataStmt.run(key, value);
    if (['reply_chance_percent', 'reaction_chance_denominator', 'always_reply_user_id', 'nerd_emoji'].includes(key) || key.startsWith('dashboard_')) this.emit('change', { type: 'config', key });
  }

  getDashboardSetting(key, fallback) {
    const value = this.getMetadata(`dashboard_${key}`);
    if (key === 'guildId' && value === 'null') return null;
    return value ?? fallback;
  }

  setDashboardSetting(key, value) {
    if (!['specialUserId', 'specialRoleId', 'guildId'].includes(key) ||
        !(key === 'guildId' && value === null) && (typeof value !== 'string' || !/^\d{17,20}$/.test(value))) {
      throw new RangeError('Invalid dashboard setting.');
    }
    this.setMetadata(`dashboard_${key}`, value === null ? 'null' : value);
    return value;
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

  getReactionChanceDenominator() {
    return Number(this.getMetadata('reaction_chance_denominator') ?? this.defaultReactionChanceDenominator);
  }

  getDownloadConcurrency() {
    const value = Number(this.getMetadata('download_concurrency') ?? 3);
    return Number.isInteger(value) && value >= 1 && value <= 10 ? value : 3;
  }

  getTriviaTimeoutSeconds() {
    const value = Number(this.getMetadata('trivia_timeout_seconds') ?? this.defaultTriviaTimeoutSeconds);
    return Number.isInteger(value) && value >= 5 && value <= 3600 ? value : this.defaultTriviaTimeoutSeconds;
  }

  get triviaLifetimeMs() {
    return this.getTriviaTimeoutSeconds() * 1000;
  }

  setTriviaTimeoutSeconds(value) {
    if (!Number.isInteger(value) || value < 5 || value > 3600) throw new RangeError('Trivia timeout must be 5 to 3600 seconds.');
    this.setMetadata('trivia_timeout_seconds', String(value));
    return value;
  }

  getTriviaBonusSeconds() {
    const value = Number(this.getMetadata('trivia_bonus_seconds') ?? this.defaultTriviaBonusSeconds);
    return Number.isFinite(value) && value >= 0 && value <= 60 ? value : this.defaultTriviaBonusSeconds;
  }

  setTriviaBonusSeconds(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 60) throw new RangeError('Trivia bonus window must be 0 to 60 seconds (0 disables it).');
    this.setMetadata('trivia_bonus_seconds', String(value));
    return value;
  }

  getTriviaOptionCount() {
    const value = Number(this.getMetadata('trivia_option_count') ?? 4);
    return Number.isInteger(value) && value >= 2 && value <= 10 ? value : 4;
  }

  setTriviaOptionCount(value) {
    if (!Number.isInteger(value) || value < 2 || value > 10) throw new RangeError('Trivia options must be 2 to 10.');
    this.setMetadata('trivia_option_count', String(value));
    return value;
  }

  getReplyDelaySeconds() {
    const value = Number(this.getMetadata('reply_delay_seconds') ?? 0);
    return Number.isFinite(value) && value >= 0 && value <= 60 ? value : 0;
  }

  setReplyDelaySeconds(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 60) throw new RangeError('Reply delay must be 0 to 60 seconds.');
    this.setMetadata('reply_delay_seconds', String(value));
    return value;
  }

  getTypingIndicator() {
    return this.getMetadata('typing_indicator') === 'true';
  }

  setTypingIndicator(value) {
    if (typeof value !== 'boolean') throw new RangeError('Typing indicator must be true or false.');
    this.setMetadata('typing_indicator', String(value));
    return value;
  }

  setDownloadConcurrency(value) {
    if (!Number.isInteger(value) || value < 1 || value > 10) throw new RangeError('Download concurrency must be 1 to 10.');
    this.setMetadata('download_concurrency', String(value));
    this.emit('change', { type: 'config', key: 'download_concurrency' });
    return value;
  }

  setReactionChanceDenominator(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) {
      throw new RangeError('Reaction chance denominator must be an integer from 1 to 1000000.');
    }
    this.setMetadata('reaction_chance_denominator', String(value));
    return value;
  }

  getAlwaysReplyUserId() {
    return this.getMetadata('always_reply_user_id') ?? this.defaultAlwaysReplyUserId;
  }

  setAlwaysReplyUserId(value) {
    if (value !== null && (typeof value !== 'string' || !/^\d{17,20}$/.test(value))) {
      throw new RangeError('Always-reply user ID must be a Discord snowflake.');
    }
    if (value === null) {
      this.deleteMetadataStmt.run('always_reply_user_id');
      this.emit('change', { type: 'config', key: 'always_reply_user_id' });
    } else {
      this.setMetadata('always_reply_user_id', value);
    }
    return this.getAlwaysReplyUserId();
  }

  getNerdEmoji() {
    return this.getMetadata('nerd_emoji') ?? this.defaultNerdEmoji;
  }

  setNerdEmoji(value) {
    if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 100)) {
      throw new RangeError('Nerd emoji must be a nonempty emoji string (max 100 characters).');
    }
    if (value === null) {
      this.deleteMetadataStmt.run('nerd_emoji');
      this.emit('change', { type: 'config', key: 'nerd_emoji' });
    } else {
      this.setMetadata('nerd_emoji', value.trim());
    }
    return this.getNerdEmoji();
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
    this.emit('change', { type: 'user', userId: normalizedUserId });

    return normalizedPercent;
  }

  listTrackedUsers() {
    return [...this.trackedUsers].sort();
  }

  listUserIds() {
    return this.userSettingsStmt.all().map((row) => String(row.user_id)).sort();
  }

  getMessageSources() {
    // Full-table GROUP BY blocks the event loop for seconds on large archives, so cache briefly.
    if (this.messageSourcesCache && Date.now() - this.messageSourcesCache.at < 30000) return this.messageSourcesCache.value;
    this.messageSourcesStmt ??= this.db.prepare(`
      SELECT user_id, guild_id, COUNT(*) AS count
      FROM user_messages
      GROUP BY user_id, guild_id
    `);
    // Rows with no server are few; only they need the legacy/non-legacy split (a full-table LIKE scan is slow).
    this.legacySplitStmt ??= this.db.prepare(`
      SELECT user_id, message_id LIKE 'legacy-%' AS legacy, COUNT(*) AS count
      FROM user_messages
      WHERE guild_id IS NULL
      GROUP BY user_id, legacy
    `);
    const sources = new Map();
    for (const row of this.messageSourcesStmt.all()) {
      if (row.guild_id === null) continue;
      const list = sources.get(String(row.user_id)) ?? [];
      list.push({ guildId: String(row.guild_id), legacy: false, count: Number(row.count) || 0 });
      sources.set(String(row.user_id), list);
    }
    for (const row of this.legacySplitStmt.all()) {
      const list = sources.get(String(row.user_id)) ?? [];
      list.push({ guildId: null, legacy: Boolean(row.legacy), count: Number(row.count) || 0 });
      sources.set(String(row.user_id), list);
    }
    this.messageSourcesCache = { at: Date.now(), value: sources };
    return sources;
  }

  // Channel IDs of downloaded messages that still have no recorded server.
  listUnassignedChannelIds() {
    return this.db.prepare('SELECT DISTINCT channel_id FROM user_messages WHERE guild_id IS NULL AND channel_id IS NOT NULL').all().map((row) => String(row.channel_id));
  }

  assignGuildToChannel(channelId, guildId) {
    this.messageSourcesCache = null;
    return this.db.prepare('UPDATE user_messages SET guild_id = ? WHERE guild_id IS NULL AND channel_id = ?').run(String(guildId), String(channelId)).changes;
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

  getTotalMediaSkipped() {
    return Number(this.totalMediaSkippedStmt.get()?.count || 0);
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
        mediaSkipped: 0,
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
      mediaSkipped: Number(row.media_skipped) || 0,
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
    this.emit('change', { type: 'user', userId: normalizedUserId });
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
    this.emit('change', { type: 'user', userId: normalizedUserId });
  }

  startUserDownload(userId) {
    const normalizedUserId = String(userId);

    this.transaction(() => {
      this.ensureUser(normalizedUserId);
      this.deleteMetadataStmt.run(`download_checkpoint:${normalizedUserId}`);
      this.deleteUserMessagesStmt.run(normalizedUserId);
      this.updateTrackedStmt.run(1, nowIso(), normalizedUserId);
      this.updateMessageCountStmt.run(0, nowIso(), null, normalizedUserId);
    });

    this.trackedUsers.add(normalizedUserId);
    this.messageCounts.set(normalizedUserId, 0);
    this.emit('change', { type: 'user', userId: normalizedUserId });
  }

  beginStagedUserDownload(jobId, userId) {
    const normalizedJobId = String(jobId);
    const normalizedUserId = String(userId);

    this.transaction(() => {
      this.ensureUser(normalizedUserId);
      this.deleteStagingMessagesStmt.run(normalizedJobId);
    });
  }

  saveDownloadJob(job) {
    this.db.prepare('INSERT OR REPLACE INTO download_jobs (id, guild_id, user_id, requested_by, limit_count, channel_ids, state) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(job.id, job.guildId, job.targetUserId, job.requestedById ?? null, job.limit, JSON.stringify(job.channelIds), job.resume ? JSON.stringify(job.resume) : null);
  }

  deleteDownloadJob(jobId) {
    this.db.prepare('DELETE FROM download_jobs WHERE id = ?').run(String(jobId));
  }

  getSavedDownloadJobs() {
    return this.db.prepare('SELECT * FROM download_jobs').all().map(row => ({
      id: row.id, guildId: row.guild_id, targetUserId: row.user_id, requestedById: row.requested_by,
      limit: row.limit_count, channelIds: JSON.parse(row.channel_ids), resume: row.state ? JSON.parse(row.state) : null,
    }));
  }

  addStagedDownloadedMessages(jobId, userId, messages, state = null) {
    if (!messages.length && !state) {
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
      if (state) this.db.prepare('UPDATE download_jobs SET state = ? WHERE id = ?').run(JSON.stringify(state), normalizedJobId);
    });

    return insertedCount;
  }

  getStagedDownloadCount(jobId) {
    return Number(this.countStagingMessagesStmt.get(String(jobId))?.count || 0);
  }

  getUserDownloadCheckpoint(userId, guildId) {
    const value = this.getMetadata(`download_checkpoint:${userId}`);
    const [savedGuild, messageId] = value?.split(':') ?? [];
    return savedGuild === String(guildId) && /^\d+$/.test(messageId ?? '') ? messageId : null;
  }

  commitStagedUserDownload(jobId, userId, mediaSkipped = 0, { guildId, checkpoint = null, newestId = null, merge = false } = {}) {
    const normalizedJobId = String(jobId);
    const normalizedUserId = String(userId);
    const key = `download_checkpoint:${normalizedUserId}`;
    let nextCount;

    this.transaction(() => {
      this.ensureUser(normalizedUserId);
      if (checkpoint) {
        if (this.getUserDownloadCheckpoint(normalizedUserId, guildId) !== checkpoint) {
          throw new Error('Download checkpoint changed while searching; retry the download.');
        }
        const added = this.promoteNewStagingMessagesStmt.run(normalizedJobId).changes;
        nextCount = this.getMessageCount(normalizedUserId) + added;
        mediaSkipped += this.getUserSummary(normalizedUserId).mediaSkipped;
      } else if (merge) {
        const added = this.promoteNewStagingMessagesStmt.run(normalizedJobId).changes;
        nextCount = this.getMessageCount(normalizedUserId) + added;
        // ponytail: scoped searches cannot deduplicate media-only IDs; retain the aggregate until they are stored per message.
        mediaSkipped = this.getUserSummary(normalizedUserId).mediaSkipped;
      } else {
        nextCount = this.getStagedDownloadCount(normalizedJobId);
        this.deleteUserMessagesStmt.run(normalizedUserId);
        this.promoteStagingMessagesStmt.run(normalizedJobId);
      }
      this.updateTrackedStmt.run(1, nowIso(), normalizedUserId);
      this.updateMessageCountStmt.run(nextCount, nowIso(), nowIso(), normalizedUserId);
      this.replaceMediaSkippedStmt.run(mediaSkipped, normalizedUserId);
      if (newestId && guildId) this.upsertMetadataStmt.run(key, `${guildId}:${newestId}`);
      else if (!checkpoint && !merge) this.deleteMetadataStmt.run(key);
      this.deleteStagingMessagesStmt.run(normalizedJobId);
    });

    this.trackedUsers.add(normalizedUserId);
    this.messageCounts.set(normalizedUserId, nextCount);
    this.emit('change', { type: 'user', userId: normalizedUserId });

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
      this.emit('change', { type: 'user', userId: normalizedUserId });
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
    this.emit('change', { type: 'user', userId: normalizedUserId });
  }

  deleteUserData(userId) {
    const normalizedUserId = String(userId);

    this.transaction(() => {
      this.deleteMetadataStmt.run(`download_checkpoint:${normalizedUserId}`);
      this.deleteUserStagingStmt.run(normalizedUserId);
      this.db.prepare('DELETE FROM download_jobs WHERE user_id = ?').run(normalizedUserId);
      this.deleteUserTriviaStmt.run(normalizedUserId);
      this.deleteUserSettingsStmt.run(normalizedUserId); // cascades archived messages
    });

    this.trackedUsers.delete(normalizedUserId);
    this.nerdedUsers.delete(normalizedUserId);
    this.messageCounts.delete(normalizedUserId);
    this.emit('change', { type: 'user', userId: normalizedUserId });
  }

  deleteStoredMessages(userId) {
    const normalizedUserId = String(userId);
    this.transaction(() => {
      this.ensureUser(normalizedUserId);
      this.deleteMetadataStmt.run(`download_checkpoint:${normalizedUserId}`);
      this.deleteUserMessagesStmt.run(normalizedUserId);
      this.updateMessageCountStmt.run(0, nowIso(), null, normalizedUserId);
    });
    this.messageCounts.set(normalizedUserId, 0);
    this.emit('change', { type: 'user', userId: normalizedUserId });
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
      this.emit('change', { type: 'user', userId: normalizedUserId });
    }
  }

  incrementMediaSkipped(userId) {
    const normalizedUserId = String(userId);
    this.ensureUser(normalizedUserId);
    // Live media has no stored message ID, so a later search cannot deduplicate its count.
    this.deleteMetadataStmt.run(`download_checkpoint:${normalizedUserId}`);
    this.incrementMediaSkippedStmt.run(nowIso(), normalizedUserId);
    this.emit('change', { type: 'user', userId: normalizedUserId });
  }

  getRandomMessage(userId) {
    return this.pickRandomMessage(userId)?.content ?? null;
  }

  getRandomMessageWithMetadata(userId) {
    return this.pickRandomMessage(userId);
  }

  pickRandomMessage(userId) {
    const id = String(userId);
    for (let attempt = 0; attempt < 3; attempt++) {
      // The cached count is exact in normal operation; fall back to a real count if it has drifted.
      let count = attempt === 0 ? this.getMessageCount(id) : 0;
      if (!count) count = Number(this.userMessageCountStmt.get(id)?.count) || 0;
      if (!count) return null;
      const row = this.messageAtOffsetStmt.get(id, Math.floor(Math.random() * count));
      if (row?.content?.trim()) return row;
    }
    return null;
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
    this.emit('change', { type: 'trivia', guildId: String(guildId) });
  }

  getActiveTriviaQuestion(guildId) {
    return this.selectTriviaActiveStmt.get(String(guildId)) ?? null;
  }

  clearActiveTriviaQuestion(guildId) {
    this.deleteTriviaActiveStmt.run(String(guildId));
    this.emit('change', { type: 'trivia', guildId: String(guildId) });
  }

  // Atomically registers a user's answer attempt.
  // Returns { status: 'no_question' | 'already_answered' | 'ok', question? }
  triviaAttempt(guildId, userId, selectedUserId = null) {
    const normalizedGuildId = String(guildId);
    const normalizedUserId = String(userId);

    const result = this.transaction(() => {
      const question = this.selectTriviaActiveStmt.get(normalizedGuildId);
      if (!question) return { status: 'no_question' };
      if (isTriviaExpired(question, Date.now(), this.triviaLifetimeMs)) {
        this.deleteTriviaActiveStmt.run(normalizedGuildId);
        return { status: 'no_question', expired: true };
      }

      const answeredIds = JSON.parse(question.answered_user_ids);
      if (answeredIds.includes(normalizedUserId)) return { status: 'already_answered' };

      const first = answeredIds.length === 0;
      answeredIds.push(normalizedUserId);
      const guesses = JSON.parse(question.guesses ?? '[]');
      const entry = { userId: normalizedUserId, guessId: selectedUserId, at: Date.now() };
      if (selectedUserId != null) entry.streak = this.recordTriviaResult(normalizedGuildId, normalizedUserId, selectedUserId === question.correct_user_id, first);
      guesses.push(entry);
      this.updateTriviaAnsweredStmt.run(JSON.stringify(answeredIds), JSON.stringify(guesses), normalizedGuildId);

      return { status: 'ok', question, streak: entry.streak ?? 0 };
    });
    if (result.expired || result.status === 'ok') this.emit('change', { type: 'trivia', guildId: normalizedGuildId });
    if (result.expired) return { status: 'no_question' };
    return result;
  }

  triviaIncrementScore(userId, guildId, points = 1) {
    this.upsertTriviaScoreStmt.run(String(userId), String(guildId), points);
    this.emit('change', { type: 'trivia', guildId: String(guildId) });
  }

  // Updates W/L, first-answer count and streaks; returns the new signed streak.
  recordTriviaResult(guildId, userId, correct, first) {
    const row = this.selectTriviaStatStmt.get(userId, guildId) ?? { streak: 0, best_win_streak: 0, best_loss_streak: 0 };
    const streak = correct ? Math.max(row.streak, 0) + 1 : Math.min(row.streak, 0) - 1;
    this.upsertTriviaStatStmt.run(userId, guildId, correct ? 1 : 0, correct ? 0 : 1, first ? 1 : 0, streak,
      Math.max(row.best_win_streak, streak), Math.max(row.best_loss_streak, -streak));
    return streak;
  }

  // sort: points|ratio, optionally _asc/_desc (default desc). Ratio = wins / max(losses, 1), only players with enough guesses.
  triviaGetLeaderboard(guildId, limit = 10, sort = 'points') {
    const dir = String(sort).endsWith('_asc') ? 'ASC' : 'DESC';
    const rows = String(sort).startsWith('ratio')
      ? this.db.prepare(`SELECT user_id, score, wins, losses, first_guesses, streak, best_win_streak, best_loss_streak FROM trivia_scores
          WHERE guild_id = ? AND wins + losses >= ? ORDER BY CAST(wins AS REAL) / MAX(losses, 1) ${dir}, wins ${dir}, user_id ASC LIMIT ?`)
        .all(String(guildId), TRIVIA_MIN_RATIO_GUESSES, limit)
      : this.db.prepare(`SELECT user_id, score, wins, losses, first_guesses, streak, best_win_streak, best_loss_streak FROM trivia_scores
          WHERE guild_id = ? ORDER BY score ${dir}, user_id ASC LIMIT ?`).all(String(guildId), limit);
    return rows.map(r => ({ ...r, ratio: r.wins + r.losses >= TRIVIA_MIN_RATIO_GUESSES ? r.wins / Math.max(r.losses, 1) : null }));
  }

  triviaGetRecords(guildId) {
    const top = column => this.db.prepare(`SELECT user_id, ${column} AS value FROM trivia_scores WHERE guild_id = ? AND ${column} > 0 ORDER BY ${column} DESC, user_id ASC LIMIT 1`).get(String(guildId));
    return Object.fromEntries(Object.entries({ winStreak: top('best_win_streak'), lossStreak: top('best_loss_streak'), firstGuesses: top('first_guesses') }).filter(([, v]) => v));
  }
}

function clampPercent(value) {
  const normalizedValue = Number(value);

  if (!Number.isFinite(normalizedValue)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(normalizedValue)));
}
