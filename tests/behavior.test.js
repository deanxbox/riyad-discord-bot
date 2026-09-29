import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { sayCommand } from '../src/commands/say.js';
import { scoreboardCommand } from '../src/commands/scoreboard.js';
import { DataStore, isTriviaExpired } from '../src/services/data-store.js';
import { createProgressPublisher } from '../src/services/download-jobs.js';
import { classifySearchMessage, downloadUserHistory } from '../src/services/history-downloader.js';
import { handleMessageCreate } from '../src/events/message-create.js';
import { createLoginLimiter, createSessionStore, createUserResolver, csrfAllowed, isSnowflake, isStaticPathSafe, sessionCookie, startWebDashboard, validateSetting } from '../src/web/server.js';

async function main() {
  const sends = [];
  const interaction = {
    user: { id: '1' },
    options: { getString: key => key === 'message' ? 'Hello' : '123' },
    channel: {
      isTextBased: () => true,
      messages: { fetch: async () => ({ reply: async () => { throw { code: 10008 }; } }) },
      send: async message => sends.push(message),
    },
    reply: async () => {},
  };
  await assert.rejects(sayCommand.execute({ interaction, config: { specialUserId: '1' } }),
    error => error.code === 10008);
  assert.deepEqual(sends, [], 'a reply failure must not turn into a plain message');
  interaction.channel.messages.fetch = async () => { throw { code: 10008 }; };
  await sayCommand.execute({ interaction, config: { specialUserId: '1' } });
  assert.deepEqual(sends, ['Hello'], 'only a missing fetched message falls back');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'riyad-check-'));
  const olderPath = path.join(dir, 'older.sqlite');
  const olderDb = new DatabaseSync(olderPath);
  olderDb.exec(`CREATE TABLE user_settings (
    user_id TEXT PRIMARY KEY, tracked INTEGER NOT NULL DEFAULT 0, nerded INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0, last_downloaded_at TEXT, updated_at TEXT NOT NULL
  )`);
  olderDb.prepare('INSERT INTO user_settings (user_id, updated_at) VALUES (?, ?)').run('legacy', new Date().toISOString());
  olderDb.close();
  const migratedStore = new DataStore(olderPath);
  assert.equal(migratedStore.getUserSummary('legacy').mediaSkipped, 0, 'old settings acquire a zero skipped count');
  migratedStore.incrementMediaSkipped('legacy');
  assert.equal(migratedStore.getUserSummary('legacy').mediaSkipped, 1, 'migrated counter can increment');
  migratedStore.close();
  const store = new DataStore(path.join(dir, 'live.sqlite'));
  const config = {
    webDashboardToken: 'test-secret',
    webDashboardPort: 0,
    webDashboardHost: '127.0.0.1',
    guildId: null,
    alwaysReplyUserId: store.getAlwaysReplyUserId(),
    nerdEmoji: store.getNerdEmoji(),
  };
  let server;
  try {
    assert.equal(isSnowflake('123456789012345678'), true);
    assert.equal(isSnowflake('../etc/passwd'), false);
    assert.equal(isStaticPathSafe('/app.js'), true);
    assert.equal(isStaticPathSafe('/../package.json'), false);
    assert.equal(validateSetting('replyChancePercent', 0), 0);
    assert.equal(validateSetting('reactionChanceDenominator', 1000000), 1000000);
    assert.throws(() => validateSetting('specialUserId', ''), RangeError);
    assert.throws(() => validateSetting('replyChancePercent', 101), RangeError);
    let clock = 1000;
    const sessions = createSessionStore(() => clock), id = sessions.create();
    assert.equal(id.length, 64);
    clock += 11 * 60 * 60 * 1000;
    assert.equal(sessions.use(id), true, 'sessions slide on use');
    clock += 2 * 60 * 60 * 1000;
    assert.equal(sessions.use(id), true, 'sliding refresh extends expiry');
    clock += 13 * 60 * 60 * 1000;
    assert.equal(sessions.use(id), false, 'sessions expire');
    sessions.prune();
    assert.equal(sessions.sessions.size, 0);
    assert.match(sessionCookie({ socket: {}, headers: {} }, id), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200/);
    assert.doesNotMatch(sessionCookie({ socket: {}, headers: {} }, id), /Secure/);
    assert.match(sessionCookie({ socket: {}, headers: { 'x-forwarded-proto': 'https' } }, id), /; Secure$/);
    assert.match(sessionCookie({ socket: { encrypted: true }, headers: {} }, id), /; Secure$/);
    const limiter = createLoginLimiter(() => clock);
    for (let i = 0; i < 3; i++) limiter.fail('ip');
    assert.equal(limiter.blocked('ip'), true);
    assert.equal(limiter.blocked('other-ip'), false);
    clock += 30001;
    assert.equal(limiter.blocked('ip'), false);
    assert.equal(csrfAllowed({ headers: { host: 'localhost:123', origin: 'http://localhost:123', 'x-requested-with': 'dashboard' } }), true);
    assert.equal(csrfAllowed({ headers: { host: 'localhost:123', origin: 'http://evil.test', 'x-requested-with': 'dashboard' } }), false);
    const changes = [], publish = createProgressPublisher(event => changes.push(event), () => clock);
    const sampleJob = { id: 'job', guildId: 'guild', targetUserId: 'user', status: 'running', downloadedCount: 0, mediaSkipped: 2 };
    publish(sampleJob); publish(sampleJob);
    assert.equal(changes.length, 1, 'progress events throttle per job');
    assert.equal(changes[0].mediaSkipped, 2, 'download SSE publishes skipped media');
    clock += 500; publish(sampleJob);
    assert.equal(changes.length, 2);
    publish(sampleJob, 'finished');
    assert.equal(changes.length, 3, 'final status is never throttled');
    let fetches = 0;
    const fakeUser = { id: '123456789012345678', username: 'resolved', globalName: 'Resolved', displayAvatarURL: () => 'https://cdn.discordapp.com/a.png' };
    const fakeClient = { users: { cache: new Map(), fetch: async () => { fetches++; await new Promise(resolve => setTimeout(resolve, 5)); return fakeUser; } }, guilds: { cache: new Map() } };
    const resolveUser = createUserResolver(fakeClient);
    const [resolvedA, resolvedB] = await Promise.all([resolveUser(fakeUser.id), resolveUser(fakeUser.id)]);
    assert.equal(fetches, 1, 'concurrent lookups are deduplicated');
    assert.deepEqual(resolvedA, resolvedB);
    assert.equal(resolvedA.displayName, 'Resolved');
    const missing = createUserResolver({ users: { cache: new Map(), fetch: async () => { throw Error('unknown user'); } }, guilds: { cache: new Map() } });
    assert.equal((await missing('223456789012345678')).username, '223456789012345678', 'unknown users fall back to their ID');
    assert.equal((await missing('223456789012345678')).avatarUrl, 'https://cdn.discordapp.com/embed/avatars/0.png',
      'unknown users receive an actual default avatar URL');
    const scoreboardCalls = [];
    await scoreboardCommand.execute({
      store: { triviaGetLeaderboard: () => [{ user_id: '123456789012345678', score: 2 }, { user_id: '223456789012345678', score: 1 }] },
      interaction: {
        guild: { id: '123456789012345678', members: { cache: new Map(), fetch: async id => {
          scoreboardCalls.push(`fetch:${id}`);
          if (id === '223456789012345678') throw Error('not a member');
          return { displayName: 'Player' };
        } } },
        deferReply: async () => scoreboardCalls.push('defer'),
        editReply: async message => scoreboardCalls.push(message.embeds[0].data.description),
      },
    });
    assert.equal(scoreboardCalls[0], 'defer', 'acknowledge scoreboard before fetching members');
    assert.match(scoreboardCalls.at(-1), /Player — 2 pts/);
    assert.match(scoreboardCalls.at(-1), /<@223456789012345678> — 1 pt/, 'missing guild members fall back to mentions');

    store.setActiveTriviaQuestion('guild', {
      correctUserId: '123', messageContent: 'text', optionUserIds: ['123'],
    });
    store.db.prepare('UPDATE trivia_active SET created_at = ? WHERE guild_id = ?')
      .run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), 'guild');
    assert.equal(isTriviaExpired(store.getActiveTriviaQuestion('guild')), true);
    assert.equal(store.triviaAttempt('guild', '456').status, 'no_question');
    assert.equal(store.getActiveTriviaQuestion('guild'), null);

    assert.throws(() => startWebDashboard({ config: { ...config, webDashboardToken: '' }, store }),
      /WEB_DASHBOARD_TOKEN/);
    const jobs = new EventEmitter();
    jobs.getActiveJobs = () => [];
    const queue = new EventEmitter();
    queue.list = () => [];
    const guildMembers = {
      cache: new Map(),
      fetch: async id => id === fakeUser.id ? { id, user: fakeUser, displayName: 'Guild player' } : null,
      search: async ({ query, limit }) => {
        assert.equal(limit, 10);
        return new Map(query === 'res' ? [[fakeUser.id, { id: fakeUser.id, user: fakeUser, displayName: 'Guild player' }]] : []);
      },
    };
    server = startWebDashboard({
      config, store, downloadJobs: jobs,
      nextReplyQueue: queue,
      client: { ...fakeClient, guilds: { cache: new Map([['123456789012345678', { id: '123456789012345678', name: 'Test guild', members: guildMembers, roles: { cache: new Map() } }]]) }, ws: { ping: 1 } },
    });
    if (!server.listening) await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = (route, options = {}) => fetch(base + route, {
      ...options, headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
    });
    const login = () => fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'dashboard' }, body: JSON.stringify({ token: 'test-secret' }) });
    const loginResponse = await login();
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get('set-cookie');
    assert.match(cookie, /sid=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200/);
    assert.doesNotMatch(cookie, /test-secret|Secure/);
    const cookieApi = (route, options = {}) => fetch(base + route, { ...options, headers: { Cookie: cookie.split(';')[0], ...(options.headers || {}) } });
    assert.equal((await cookieApi('/api/session')).status, 200);
    assert.equal((await cookieApi('/api/state')).status, 200, 'cookie works without bearer after reload');
    const memberRoute = '/api/members?guildId=123456789012345678&query=res';
    assert.equal((await fetch(base + memberRoute)).status, 401, 'member search requires dashboard authentication');
    assert.equal((await api('/api/members?guildId=223456789012345678&query=res')).status, 400, 'member search rejects unknown guilds');
    assert.equal((await api('/api/members?guildId=123456789012345678&query=r')).status, 400, 'member search rejects broad queries');
    assert.equal((await (await api(memberRoute)).json()).members[0].displayName, 'Guild player');
    assert.equal((await (await api('/api/members?guildId=123456789012345678&query=123456789012345678')).json()).members[0].id, fakeUser.id);
    assert.equal((await cookieApi('/api/settings', { method: 'POST', body: JSON.stringify({ reactionChanceDenominator: 7 }) })).status, 403);
    assert.equal((await cookieApi('/api/settings', { method: 'POST', headers: { 'X-Requested-With': 'dashboard', Origin: 'http://evil.test' }, body: JSON.stringify({ reactionChanceDenominator: 7 }) })).status, 403);
    assert.equal((await cookieApi('/api/settings', { method: 'POST', headers: { 'X-Requested-With': 'dashboard', Origin: base }, body: JSON.stringify({ reactionChanceDenominator: 7 }) })).status, 200);
    assert.equal((await fetch(base + '/api/events')).status, 401);
    const bearerController = new AbortController();
    const bearerEvents = await api('/api/events', { signal: bearerController.signal });
    assert.equal(bearerEvents.status, 200, 'bearer scripts can subscribe to events');
    bearerController.abort();
    for (let i = 0; i < 20 && server.liveClientCount(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    const controller = new AbortController();
    const events = await cookieApi('/api/events', { signal: controller.signal });
    assert.equal(events.status, 200);
    assert.equal(events.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(server.liveClientCount(), 1);
    const reader = events.body.getReader();
    await reader.read(); // retry instruction
    jobs.emit('change', { type: 'progress', id: 'test-job' });
    const eventChunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(eventChunk, /event: download\ndata: .*"id":"test-job"/);
    await cookieApi('/api/settings', { method: 'POST', headers: { 'X-Requested-With': 'dashboard' }, body: JSON.stringify({ reactionChanceDenominator: 9 }) });
    const configChunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(configChunk, /event: config/);
    await reader.cancel(); controller.abort();
    for (let i = 0; i < 20 && server.liveClientCount(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(server.liveClientCount(), 0, 'stream is removed on disconnect');
    assert.equal((await cookieApi('/api/logout', { method: 'POST', headers: { 'X-Requested-With': 'dashboard' } })).status, 200);
    assert.equal((await cookieApi('/api/session')).status, 401, 'logout invalidates session');
    assert.equal((await login()).status, 200);
    for (let i = 0; i < 3; i++) {
      const failed = await fetch(base + '/api/login', { method: 'POST', headers: { 'X-Requested-With': 'dashboard', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'wrong' }) });
      assert.equal(failed.status, 401);
    }
    const limited = await login();
    assert.equal(limited.status, 429, 'login is rate limited per IP after repeated failures');
    assert.equal((await fetch(base + '/api/state')).status, 401);
    assert.equal((await fetch(base + '/api/backup')).status, 401);
    assert.equal((await fetch(base + '/api/settings', { method: 'POST' })).status, 401);
    assert.equal((await api('/api/settings', {
      method: 'POST', body: JSON.stringify({ reactionChanceDenominator: '8' }),
    })).status, 400);
    assert.equal((await api('/api/settings', {
      method: 'POST', body: JSON.stringify({ reactionChanceDenominator: 8 }),
    })).status, 200);
    assert.equal((await (await api('/api/state')).json()).reactionChanceDenominator, 8);
    assert.equal((await fetch(base + '/')).status, 200);
    const appScript = await fetch(base + '/app.js');
    assert.equal(appScript.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.match(await appScript.text(), /Connect securely|connect/);
    assert.equal((await fetch(base + '/app.css')).headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal((await fetch(base + '/%2e%2e/package.json')).status, 404);
    const state = await (await api('/api/state')).json();
    assert.equal(state.guilds[0].name, 'Test guild');
    assert.equal(JSON.stringify(state).includes('test-secret'), false);
    store.triviaIncrementScore(fakeUser.id, '123456789012345678');
    const leaderboardState = await (await api('/api/state?guildId=123456789012345678')).json();
    assert.equal(leaderboardState.leaderboard[0].score, 1);
    assert.equal(leaderboardState.leaderboard[0].user.avatarUrl, 'https://cdn.discordapp.com/a.png');
    assert.equal((await api('/api/settings', { method: 'POST', body: JSON.stringify({ specialUserId: '223456789012345678' }) })).status, 200);
    assert.equal(config.specialUserId, '223456789012345678');
    assert.equal(store.getDashboardSetting('specialUserId', null), '223456789012345678');
    assert.equal((await api('/api/settings', { method: 'POST', body: JSON.stringify({ DISCORD_TOKEN: 'nope' }) })).status, 400);
    assert.equal((await api('/api/settings', { method: 'POST', body: JSON.stringify({ guildId: '' }) })).status, 400);
    assert.equal((await api('/api/settings', { method: 'POST', body: 'x'.repeat(65537) })).status, 413);
    assert.equal((await api('/api/settings', { method: 'POST', body: JSON.stringify({ guildId: null }) })).status, 200);
    assert.equal(store.getDashboardSetting('guildId', 'fallback'), null, 'an explicitly cleared guild persists as null');

    const targetId = '323456789012345678';
    const searchMessage = (id, content, media = {}) => ({
      id, author: { id: targetId }, content, channel_id: 'channel', timestamp: new Date().toISOString(), ...media,
    });
    assert.equal(classifySearchMessage(searchMessage('1', 'hello', { attachments: [{}] }), targetId), 'text');
    assert.equal(classifySearchMessage(searchMessage('1', ' ', { attachments: [{}] }), targetId), 'media-only');
    assert.equal(classifySearchMessage(searchMessage('1', '', { sticker_items: [{}] }), targetId), 'media-only');
    assert.equal(classifySearchMessage(searchMessage('1', '', { embeds: [{}] }), targetId), 'media-only');
    assert.equal(classifySearchMessage(searchMessage('1', '', {}), targetId), 'ignored');
    assert.equal(classifySearchMessage({ ...searchMessage('1', '', { attachments: [{}] }), author: { id: 'other' } }, targetId), 'ignored');
    assert.equal(store.getUserSummary(targetId).mediaSkipped, 0);
    store.setTracked(targetId, true);
    const userChanges = [];
    store.on('change', change => { if (change.type === 'user' && change.userId === targetId) userChanges.push(change); });
    const liveMessage = (content, attachments = 0, stickers = 0, embeds = 0) => ({
      inGuild: () => true, author: { id: targetId, bot: false }, content,
      attachments: { size: attachments }, stickers: { size: stickers }, embeds: Array(embeds).fill({}),
      id: 'live-1', guildId: 'guild', channelId: 'channel', createdAt: new Date(),
      mentions: { has: () => false, repliedUser: null }, client: { user: { id: 'bot' } },
    });
    const liveConfig = { alwaysReplyUserId: 'other' };
    await handleMessageCreate(liveMessage(' '), { store, config: liveConfig });
    assert.equal(store.getUserSummary(targetId).mediaSkipped, 0, 'empty system noise is ignored');
    for (const media of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
      await handleMessageCreate(liveMessage('', ...media), { store, config: liveConfig });
    }
    assert.equal(store.getUserSummary(targetId).mediaSkipped, 3);
    assert.equal(userChanges.length, 3, 'live media count emits user changes for SSE');
    assert.equal(store.getTotalStoredMessages(), 0, 'media-only content is never stored');
    assert.equal(store.getTotalMediaSkipped(), 3);

    const download = (jobId, messages, limit = null) => downloadUserHistory({
      client: { rest: { get: async (route, { query: params }) => {
        assert.equal(route.includes('?'), false, 'search query must not alter the rate-limit bucket route');
        const page = messages.filter(message => !params.has('max_id') || BigInt(message.id) < BigInt(params.get('max_id')))
          .slice(0, Number(params.get('limit')));
        return { total_results: messages.length, messages: page.map(message => [message]) };
      } } },
      guildId: 'guild', targetUserId: targetId, limit, store, jobId, onProgress: async () => {},
    });
    const firstDownload = await download('media-job', [searchMessage('103', '', { attachments: [{}] }), searchMessage('102', 'text'), searchMessage('101', '')]);
    assert.equal(firstDownload.downloadedCount, 1);
    assert.equal(firstDownload.mediaSkipped, 1);
    assert.equal(store.getUserSummary(targetId).mediaSkipped, 1, 'download replaces prior live skip count');
    assert.deepEqual(store.exportUserMessages(targetId).map(message => message.content), ['text']);
    const secondDownload = await download('redownload-job', [searchMessage('104', 'new text')]);
    assert.equal(secondDownload.mediaSkipped, 1);
    assert.equal(store.getUserSummary(targetId).mediaSkipped, 1, 'incremental download keeps previously skipped media');
    assert.deepEqual(store.exportUserMessages(targetId).map(message => message.content), ['text', 'new text']);
    const limitedDownload = await download('limited-job', [searchMessage('105', '', { sticker_items: [{}] }), searchMessage('104', 'new text')], 1);
    assert.equal(limitedDownload.downloadedCount, 0, 'media-only results consume the search limit');
    assert.equal(limitedDownload.mediaSkipped, 1);
    assert.equal(store.getUserSummary(targetId).mediaSkipped, 1);
    const mediaState = await (await api('/api/state')).json();
    assert.equal(mediaState.users.find(user => user.user.id === targetId).mediaSkipped, 1, 'dashboard state exposes skipped media');
    assert.equal(mediaState.stats.mediaSkipped, 1, 'dashboard stats expose skipped media total');

    store.setTracked('123456789012345678', true);
    store.setNerded('123456789012345678', true);
    store.setUserReplyChanceOverride('123456789012345678', 23);
    store.setTracked('123456789012345678', false);
    const usersState = await (await api('/api/state')).json();
    assert.ok(usersState.users.some(user => user.user.id === '123456789012345678'),
      'untracked users with existing data remain visible for editing');
    store.setTracked('123456789012345678', true);
    const deleteResponse = await api('/api/users/123456789012345678', {
      method: 'POST', body: JSON.stringify({ deleteMessages: true }),
    });
    const afterDelete = await deleteResponse.json();
    assert.equal(afterDelete.tracked, true);
    assert.equal(afterDelete.nerded, true);
    assert.equal(afterDelete.replyChanceOverride, 23);
    assert.equal(afterDelete.messageCount, 0, 'deleting stored messages does not untrack or clear per-user settings');
    const backup = await (await api('/api/backup')).arrayBuffer();
    const file = path.join(dir, 'snapshot.sqlite');
    await fs.writeFile(file, Buffer.from(backup));
    const snapshot = new DatabaseSync(file);
    try {
      assert.equal(snapshot.prepare('SELECT tracked FROM user_settings WHERE user_id = ?')
        .get('123456789012345678').tracked, 1);
      assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { snapshot.close(); }
    console.log('Self-check passed: say fallback, trivia expiry, dashboard auth and SQLite backup.');
  } finally {
    if (server) {
      server.close();
      await once(server, 'close');
    }
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
