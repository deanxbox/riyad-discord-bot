import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { sayCommand } from '../src/commands/say.js';
import { scoreboardCommand } from '../src/commands/scoreboard.js';
import { nextReplyCommand } from '../src/commands/next-reply.js';
import { NextReplyQueue } from '../src/services/next-reply-queue.js';
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

  const commandQueue = new NextReplyQueue(), commandReplies = [];
  const commandOptions = nextReplyCommand.data.toJSON().options;
  assert.equal(commandOptions.find(option => option.name === 'user').type, 6, 'user is a Discord user picker');
  assert.equal(commandOptions.find(option => option.name === 'user').required, false);
  assert.equal(commandOptions.find(option => option.name === 'user_id').type, 3, 'raw ID remains a string fallback');
  const queueCommand = (user, userId) => nextReplyCommand.execute({
    nextReplyQueue: commandQueue, config: { specialUserId: '123456789012345678' },
    interaction: {
      user: { id: '123456789012345678' },
      options: { getUser: () => user, getString: key => key === 'message' ? 'Queued text' : userId },
      reply: async reply => commandReplies.push(reply),
    },
  });
  await queueCommand({ id: '223456789012345678' }, 'invalid');
  assert.equal(commandQueue.list().at(-1).targetUserId, '223456789012345678', 'picked user wins even over an invalid fallback');
  await queueCommand(null, '323456789012345678');
  assert.equal(commandQueue.list().at(-1).targetUserId, '323456789012345678');
  await queueCommand(null, null);
  assert.equal(commandQueue.list().at(-1).targetUserId, null, 'omitted target queues for any user');
  for (const invalid of ['invalid', '', '123', '<@323456789012345678>']) {
    await queueCommand(null, invalid);
    assert.equal(commandReplies.at(-1).ephemeral, true);
    assert.match(commandReplies.at(-1).content, /valid Discord user ID/);
  }
  assert.equal(commandQueue.size(), 3, 'invalid fallbacks never enqueue');
  const queueChanges = [];
  commandQueue.on('change', change => queueChanges.push(change));
  const removed = commandQueue.list()[1];
  assert.deepEqual(commandQueue.remove(removed.id), removed);
  assert.deepEqual(queueChanges, [{ type: 'queue', id: removed.id }]);
  assert.equal(commandQueue.remove(removed.id), null);
  assert.equal(queueChanges.length, 1, 'missing removal does not emit a change');
  assert.equal(commandQueue.consume('223456789012345678').targetUserId, '223456789012345678');
  assert.equal(commandQueue.consume('323456789012345678').targetUserId, null, 'remaining any-user entry still consumes');
  assert.throws(() => commandQueue.enqueue({ message: ' \n ' }), /message or image/);

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
    jobs.getJobStatus = () => null;
    const startedJobs = [];
    jobs.startHeadless = options => { startedJobs.push(options); return { created: true }; };
    const queue = new NextReplyQueue();
    const guildMembers = {
      cache: new Map(),
      fetch: async id => id === fakeUser.id ? { id, user: fakeUser, displayName: 'Guild player' } : null,
      search: async ({ query, limit }) => {
        assert.equal(limit, 10);
        return new Map(query === 'res' ? [[fakeUser.id, { id: fakeUser.id, user: fakeUser, displayName: 'Guild player' }]] : []);
      },
    };
    const channels = new Map([
      ['323456789012345678', { id: '323456789012345678', name: 'general', position: 4, isTextBased: () => true, permissionsFor: () => ({ has: () => true }) }],
      ['423456789012345678', { id: '423456789012345678', name: 'private', isTextBased: () => true, permissionsFor: () => ({ has: () => false }) }],
      ['523456789012345678', { id: '523456789012345678', name: 'voice', isTextBased: () => false, permissionsFor: () => ({ has: () => true }) }],
    ]);
    const guild = { id: '123456789012345678', name: 'Test guild', members: guildMembers, roles: { cache: new Map() }, channels: { cache: channels } };
    const botClient = { ...fakeClient, user: { id: 'bot' }, guilds: { cache: new Map([[guild.id, guild]]) }, ws: { ping: 1 } };
    server = startWebDashboard({
      config, store, downloadJobs: jobs,
      nextReplyQueue: queue,
      client: botClient,
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
    const postQueue = body => api('/api/queue', { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await fetch(base + '/api/queue', { method: 'POST', body: JSON.stringify({ message: 'Unauthorized' }) })).status, 401);
    assert.equal((await fetch(base + '/api/queue/missing', { method: 'DELETE' })).status, 401);
    assert.equal((await cookieApi('/api/queue', { method: 'POST', body: JSON.stringify({ message: 'No CSRF header' }) })).status, 403);
    assert.equal((await cookieApi('/api/queue', { method: 'POST', headers: { 'X-Requested-With': 'dashboard', Origin: 'http://evil.test' }, body: JSON.stringify({ message: 'Bad origin' }) })).status, 403);
    for (const body of [null, [], 'text', {}, { message: null }, { message: 123 }, { message: '' }, { message: ' \n ' },
      { message: 'x'.repeat(2001) }, { message: 'Hi', targetUserId: 'invalid' }, { message: 'Hi', targetUserId: '' },
      { message: 'Hi', targetUserId: 123456789012345678 }, { message: 'Hi', targetUserId: [] },
      { message: 'Hi', createdByUserId: fakeUser.id }]) {
      assert.equal((await postQueue(body)).status, 400, `queue rejects ${JSON.stringify(body)}`);
    }
    assert.equal(queue.size(), 0, 'invalid requests do not mutate the queue');
    const addQueueResponse = await cookieApi('/api/queue', { method: 'POST', headers: { 'X-Requested-With': 'dashboard', Origin: base }, body: JSON.stringify({ message: '  Hello\nthere  ', targetUserId: fakeUser.id }) });
    assert.equal(addQueueResponse.status, 201);
    const addedQueueEntry = (await addQueueResponse.json()).entry;
    assert.equal(addedQueueEntry.message, 'Hello\nthere');
    assert.equal(addedQueueEntry.targetUserId, fakeUser.id);
    assert.equal(addedQueueEntry.createdByUserId, 'dashboard');
    for (const body of [{ message: 'x'.repeat(2000) }, { message: 'Any user', targetUserId: null }]) {
      const response = await postQueue(body);
      assert.equal(response.status, 201);
      assert.equal((await response.json()).entry.targetUserId, null);
    }
    const fetchedIds = [];
    const originalFetch = botClient.users.fetch;
    botClient.users.fetch = async id => { fetchedIds.push(id); return originalFetch(id); };
    const queueState = (await (await api('/api/state')).json()).queue;
    assert.equal(queueState.length, 3);
    assert.equal(queueState[0].target.id, fakeUser.id);
    assert.equal(queueState[0].createdBy.displayName, 'Dashboard');
    assert.equal(queueState[1].target, null);
    assert.ok(fetchedIds.every(isSnowflake), 'dashboard creator marker must never reach Discord user fetching');
    botClient.users.fetch = originalFetch;
    const removeRoute = `/api/queue/${addedQueueEntry.id}`;
    assert.equal((await cookieApi(removeRoute, { method: 'DELETE' })).status, 403);
    assert.equal((await cookieApi(removeRoute, { method: 'DELETE', headers: { 'X-Requested-With': 'dashboard', Origin: 'http://evil.test' } })).status, 403);
    assert.equal(queue.size(), 3, 'denied deletion preserves entries');
    assert.equal((await cookieApi(removeRoute, { method: 'DELETE', headers: { 'X-Requested-With': 'dashboard', Origin: base } })).status, 200);
    assert.equal((await api(removeRoute, { method: 'DELETE' })).status, 404);
    assert.equal((await api('/api/queue/missing', { method: 'DELETE' })).status, 404);
    assert.equal(queue.size(), 2);
    for (const entry of queue.list()) assert.equal((await api(`/api/queue/${entry.id}`, { method: 'DELETE' })).status, 200);
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const imageUpload = { name: '..\\..\\photo<>?.exe', contentType: 'image/png', data: imageBytes.toString('base64') };
    for (const image of [null, [], 'image', {}, { ...imageUpload, contentType: 'image/svg+xml' },
      { ...imageUpload, contentType: 'toString' }, { ...imageUpload, name: '' }, { ...imageUpload, name: 1 },
      { ...imageUpload, data: '' }, { ...imageUpload, data: 'not-base64!' }, { ...imageUpload, data: [1] },
      { ...imageUpload, extra: true }]) {
      assert.equal((await postQueue({ message: 'Hi', image })).status, 400, 'reject invalid image even when text is supplied');
    }
    assert.equal((await postQueue({ image: imageUpload, message: null })).status, 400);
    assert.equal((await postQueue({ image: imageUpload, message: 'x'.repeat(2001) })).status, 400);
    assert.equal((await postQueue({ image: imageUpload, extra: true })).status, 400, 'outer keys remain strict');
    assert.equal((await postQueue({ image: { ...imageUpload, data: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') } })).status, 400, 'decoded size cannot exceed 8 MiB');
    assert.equal(queue.size(), 0, 'invalid image requests never enqueue');
    const maxImageResponse = await postQueue({ image: { ...imageUpload, data: Buffer.alloc(8 * 1024 * 1024).toString('base64') } });
    assert.equal(maxImageResponse.status, 201, '8 MiB images fit the route-specific body limit');
    const maxImageEntry = (await maxImageResponse.json()).entry;
    assert.equal(maxImageEntry.image.size, 8 * 1024 * 1024);
    assert.equal(maxImageEntry.image.data, undefined, 'POST response must not echo bytes');
    assert.equal((await api(`/api/queue/${maxImageEntry.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await api('/api/settings', { method: 'POST', body: JSON.stringify({ padding: 'x'.repeat(65536) }) })).status, 413, 'other routes keep the 65536-byte limit');
    assert.equal((await postQueue({ image: { ...imageUpload, data: 'x'.repeat(12 * 1024 * 1024) } })).status, 413, 'queue body limit remains bounded');

    for (const contentType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      const response = await postQueue({ image: { ...imageUpload, contentType } });
      assert.equal(response.status, 201, `${contentType} allows image-only replies`);
      const entry = (await response.json()).entry;
      assert.equal(entry.message, '');
      assert.equal(entry.hasImage, true);
      assert.match(entry.image.name, /^photo___\.(png|jpg|gif|webp)$/);
      assert.deepEqual(queue.list().at(-1).image.data, imageBytes, 'queue holds decoded Buffers');
      assert.equal(queue.list().at(-1).image.contentType, contentType);
    }
    assert.equal((await postQueue({ message: '  Caption  ', targetUserId: fakeUser.id, image: imageUpload })).status, 201);
    const imageState = (await (await api('/api/state')).json()).queue;
    assert.equal(imageState.length, 5);
    for (const entry of imageState) {
      assert.equal(entry.hasImage, true);
      assert.deepEqual(entry.image, { name: entry.image.name, size: imageBytes.length }, 'state contains only image metadata');
      assert.equal(JSON.stringify(entry).includes(imageUpload.data), false);
      assert.equal(JSON.stringify(entry).includes('"data"'), false);
    }
    const imageReplies = [];
    const replyStore = {
      isTracked: () => true, isNerded: () => false, getMessageCount: () => 1,
      getEffectiveReplyChancePercent: () => 100, getReplyDelaySeconds: () => 0, getTypingIndicator: () => false,
      getRandomMessage: () => { throw Error('Queued image replies must not fall back to stored text'); },
    };
    const replyMessage = {
      inGuild: () => true, author: { id: fakeUser.id, bot: false }, content: '',
      attachments: { size: 0 }, stickers: { size: 0 }, embeds: [],
      mentions: { has: () => true }, client: { user: { id: 'bot' } },
      reply: async reply => imageReplies.push(reply),
    };
    await handleMessageCreate(replyMessage, { store: replyStore, config, nextReplyQueue: queue });
    assert.deepEqual(imageReplies.at(-1), { content: 'Caption', files: [{ attachment: imageBytes, name: 'photo___.png' }], allowedMentions: { repliedUser: false } });
    assert.equal(queue.size(), 4, 'targeted image reply takes priority over any-user entries');
    await handleMessageCreate(replyMessage, { store: replyStore, config, nextReplyQueue: queue });
    assert.deepEqual(imageReplies.at(-1), { files: [{ attachment: imageBytes, name: 'photo___.png' }], allowedMentions: { repliedUser: false } }, 'image-only sends files and omits content');
    for (const entry of queue.list()) queue.remove(entry.id);
    queue.enqueue({ message: 'x'.repeat(2001), image: { name: 'photo.png', contentType: 'image/png', data: imageBytes } });
    await handleMessageCreate(replyMessage, { store: replyStore, config, nextReplyQueue: queue });
    assert.equal(imageReplies.at(-1).content.length, 2000, 'image captions still use truncateReply');
    queue.enqueue({ message: 'Text only' });
    await handleMessageCreate(replyMessage, { store: replyStore, config, nextReplyQueue: queue });
    assert.deepEqual(imageReplies.at(-1), { content: 'Text only', allowedMentions: { repliedUser: false } }, 'text-only behavior remains unchanged');
    const memberRoute = '/api/members?guildId=123456789012345678&query=res';
    assert.equal((await fetch(base + memberRoute)).status, 401, 'member search requires dashboard authentication');
    assert.equal((await api('/api/members?guildId=223456789012345678&query=res')).status, 400, 'member search rejects unknown guilds');
    assert.equal((await api('/api/members?guildId=123456789012345678&query=r')).status, 400, 'member search rejects broad queries');
    assert.equal((await (await api(memberRoute)).json()).members[0].displayName, 'Guild player');
    assert.equal((await (await api('/api/members?guildId=123456789012345678&query=123456789012345678')).json()).members[0].id, fakeUser.id);
    assert.deepEqual((await (await api('/api/guilds/123456789012345678/channels')).json()).channels,
      [{ id: '323456789012345678', name: 'general', categoryId: null, categoryName: null }], 'channel list includes only readable text channels');
    const earlyCategory = { id: '623456789012345678', name: 'Z first category', position: 2 };
    const lateCategory = { id: '723456789012345678', name: 'A second category', position: 8 };
    const orderedChannels = [
      { id: '823456789012345678', name: 'late-category-bottom', parent: lateCategory, position: 6 },
      { id: '823456789012345679', name: 'early-category-bottom', parent: earlyCategory, position: 8 },
      { id: '823456789012345680', name: 'uncategorised-bottom', parent: null, position: 9 },
      { id: '823456789012345681', name: 'late-category-top', parent: lateCategory, position: 2 },
      { id: '823456789012345682', name: 'early-category-top', parent: earlyCategory, position: 2 },
      { id: '823456789012345683', name: 'uncategorised-top', parent: null, position: 1 },
    ];
    for (const channel of orderedChannels) channels.set(channel.id, { ...channel, isTextBased: () => true, permissionsFor: () => ({ has: () => true }) });
    const sortedChannels = (await (await api(`/api/guilds/${guild.id}/channels`)).json()).channels;
    assert.deepEqual(sortedChannels.map(channel => channel.name), [
      'uncategorised-top', 'general', 'uncategorised-bottom',
      'early-category-top', 'early-category-bottom', 'late-category-top', 'late-category-bottom',
    ], 'channels follow Discord category and channel positions, not cache insertion or alphabetical order');
    assert.deepEqual(sortedChannels.map(channel => [channel.categoryId, channel.categoryName]), [
      [null, null], [null, null], [null, null],
      [earlyCategory.id, earlyCategory.name], [earlyCategory.id, earlyCategory.name],
      [lateCategory.id, lateCategory.name], [lateCategory.id, lateCategory.name],
    ], 'channel responses include category identity and name');
    for (const channel of orderedChannels) channels.delete(channel.id);
    store.setTracked(fakeUser.id, true);
    assert.equal((await api('/api/downloads', { method: 'POST', body: JSON.stringify({ userId: fakeUser.id, guildId: guild.id, channelIds: ['323456789012345678'], limit: null }) })).status, 202);
    assert.deepEqual(startedJobs.at(-1).channelIds, ['323456789012345678'], 'single downloads snapshot validated channels');
    assert.equal((await api('/api/downloads', { method: 'POST', body: JSON.stringify({ userId: fakeUser.id, limit: null }) })).status, 400,
      'omitted guild is rejected when no configured default exists');
    config.guildId = guild.id;
    assert.equal((await api('/api/downloads', { method: 'POST', body: JSON.stringify({ userId: fakeUser.id, limit: null }) })).status, 202,
      'single downloads use the configured guild when omitted');
    assert.equal(startedJobs.at(-1).guildId, guild.id);
    assert.equal((await api('/api/downloads', { method: 'POST', body: JSON.stringify({ userId: fakeUser.id, guildId: '223456789012345678', limit: null }) })).status, 400,
      'an explicit unknown guild is rejected instead of falling back');
    config.guildId = null;
    assert.equal((await api('/api/downloads', { method: 'POST', body: JSON.stringify({ userId: fakeUser.id, guildId: guild.id, channelIds: ['423456789012345678'], limit: null }) })).status, 400,
      'downloads reject channels without readable permissions');
    const tooManyChannels = Array.from({ length: 501 }, (_, i) => String(600000000000000000n + BigInt(i)));
    for (const id of tooManyChannels) channels.set(id, { id, name: 'readable', isTextBased: () => true, permissionsFor: () => ({ has: () => true }) });
    assert.equal((await api('/api/downloads', { method: 'POST', body: JSON.stringify({ userId: fakeUser.id, guildId: guild.id, channelIds: tooManyChannels, limit: null }) })).status, 400,
      'channel selection is capped at the documented API maximum');
    assert.equal((await api('/api/users/bulk', { method: 'POST', body: JSON.stringify({ action: 'download', userIds: [fakeUser.id], guildId: guild.id, channelIds: ['323456789012345678'] }) })).status, 202);
    assert.deepEqual(startedJobs.at(-1).channelIds, ['323456789012345678'], 'bulk downloads use the selected guild/channel snapshot');
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
    console.log('Self-check passed: say fallback, next-reply targeting and queue API, trivia expiry, dashboard auth and SQLite backup.');
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
