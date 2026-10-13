import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { DataStore } from '../src/services/data-store.js';
import { DownloadJobManager } from '../src/services/download-jobs.js';
import { NextReplyQueue } from '../src/services/next-reply-queue.js';
import { VoiceManager } from '../src/services/voice-manager.js';
import { buildTriviaComponents, handleTriviaButton, triviaCommand } from '../src/commands/trivia.js';
import { contentPayload, mentionList, truncateContent } from '../src/commands/helpers.js';
import { joinCommand } from '../src/commands/join.js';
import { exportUserCommand } from '../src/commands/export-user.js';
import { randomLineCommand } from '../src/commands/random-line.js';
import { downloadStatusCommand } from '../src/commands/download-status.js';
import { sayCommand } from '../src/commands/say.js';
import { nextReplyCommand } from '../src/commands/next-reply.js';
import { handleInteractionCreate } from '../src/events/interaction-create.js';
import { startWebDashboard } from '../src/web/server.js';
import { ChannelType } from 'discord.js';

const guildId = '123456789012345678', userId = '223456789012345678';
const message = (id, content = `text-${id}`) => ({ messageId: String(id), userId, guildId, channelId: 'channel', content, createdAt: '2026-01-01T00:00:00Z' });
const memoryStore = t => { const store = new DataStore(':memory:'); t.after(() => store.close()); return store; };
const managerFor = store => new DownloadJobManager({ store, config: {}, client: { rest: { get: async () => ({ messages: [], total_results: 0 }) } } });
const saveJob = (store, id = 'job') => { store.saveDownloadJob({ id, guildId, targetUserId: userId, limit: null, channelIds: [] }); store.beginStagedUserDownload(id, userId); };
const setQuestion = store => store.setActiveTriviaQuestion('channel', { correctUserId: 'correct', messageContent: 'hello', optionUserIds: ['correct', 'wrong'] });
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const incremental of [false, true]) {
  test(`crash after ${incremental ? 'incremental' : 'replacement'} promotion cannot resume an empty archive`, t => {
    const store = memoryStore(t);
    store.addDownloadedMessages(userId, [message('old')]);
    if (incremental) store.setMetadata(`download_checkpoint:${userId}`, `${guildId}:100`);
    saveJob(store);
    store.addStagedDownloadedMessages('job', userId, [message('new')], { reachedCheckpoint: true, checkpoint: incremental ? '100' : null });
    let observed = false;
    store.on('change', () => {
      assert.equal(store.getSavedDownloadJobs().length, 0, 'durable row disappears before post-commit observers');
      assert.equal(store.getStagedDownloadCount('job'), 0);
      assert.equal(store.getUserDownloadCheckpoint(userId, guildId), '200');
      observed = true;
    });
    const count = store.commitStagedUserDownload('job', userId, 2, { guildId, checkpoint: incremental ? '100' : null, newestId: '200' });
    assert.equal(count, incremental ? 2 : 1);
    assert.equal(store.getUserSummary(userId).mediaSkipped, 2);
    assert.ok(observed);
    const archive = store.exportUserMessages(userId);
    store.loadCaches(); // simulate restart; no saved job is available to schedule
    const restarted = managerFor(store);
    restarted.resumeSavedJobs();
    assert.equal(restarted.getActiveJobCount(), 0);
    assert.deepEqual(store.exportUserMessages(userId), archive);
    assert.equal(store.getMessageCount(userId), count);
  });
}

test('promotion, checkpoint, count, staging and durable deletion roll back together', t => {
  const store = memoryStore(t);
  store.addDownloadedMessages(userId, [message('old')]);
  saveJob(store);
  store.addStagedDownloadedMessages('job', userId, [message('new')]);
  t.mock.method(store, 'deleteDownloadJob', () => { throw Error('delete failed'); });
  let changes = 0;
  store.on('change', () => changes++);
  assert.throws(() => store.commitStagedUserDownload('job', userId, 3, { guildId, newestId: '200' }), /delete failed/);
  assert.deepEqual(store.exportUserMessages(userId).map(r => r.message_id), ['old']);
  assert.equal(store.getUserSummary(userId).messageCount, 1);
  assert.equal(store.getMessageCount(userId), 1);
  assert.equal(store.getUserDownloadCheckpoint(userId, guildId), null);
  assert.equal(store.getStagedDownloadCount('job'), 1);
  assert.equal(store.getSavedDownloadJobs().length, 1);
  assert.equal(changes, 0);
});

test('replacement preserves post-snapshot live rows and deduplicates them; scoped merge retains old rows', t => {
  const store = memoryStore(t);
  store.addDownloadedMessages(userId, [message('old')]);
  saveJob(store);
  store.appendLiveMessage(message('live', 'live content'));
  store.addStagedDownloadedMessages('job', userId, [message('live', 'stale search content'), message('new')]);
  assert.equal(store.commitStagedUserDownload('job', userId), 2);
  assert.equal(store.exportUserMessages(userId).find(r => r.message_id === 'live').content, 'live content');
  assert.equal(store.exportUserMessages(userId).some(r => r.message_id === 'old'), false);
  assert.equal(store.getMessageCount(userId), 2);
  saveJob(store, 'scoped');
  store.addStagedDownloadedMessages('scoped', userId, [message('scoped')]);
  assert.equal(store.commitStagedUserDownload('scoped', userId, 0, { merge: true }), 3);
  assert.equal(store.getUserSummary(userId).messageCount, 3);
});

test('live insertion cannot reuse a deleted rowid below a pending snapshot', t => {
  const store = memoryStore(t);
  store.addDownloadedMessages(userId, [message('old')]);
  store.addDownloadedMessages('other', [message('highest')]);
  saveJob(store);
  const snapshot = store.getSavedDownloadJobs()[0].snapshotRowId;
  store.deleteUserData('other');
  store.appendLiveMessage(message('live'));
  assert.ok(store.db.prepare('SELECT rowid FROM user_messages WHERE message_id = ?').get('live').rowid > snapshot);
  store.commitStagedUserDownload('job', userId);
  assert.deepEqual(store.exportUserMessages(userId).map(r => r.message_id), ['live']);
});

for (const live of [false, true]) {
  test(`${live ? 'live' : 'batch'} insert rolls back rows and counts without changing cache or emitting`, t => {
    const store = memoryStore(t);
    store.addDownloadedMessages(userId, [message('old')]);
    let changes = 0;
    store.on('change', () => changes++);
    const update = store.updateMessageCountStmt;
    store.updateMessageCountStmt = { run: () => { throw Error('count failed'); } };
    assert.throws(() => live ? store.appendLiveMessage(message('new')) : store.addDownloadedMessages(userId, [message('new'), message('second')]), /count failed/);
    assert.deepEqual(store.exportUserMessages(userId).map(r => r.message_id), ['old']);
    assert.equal(store.getUserSummary(userId).messageCount, 1);
    assert.equal(store.getMessageCount(userId), 1);
    assert.equal(changes, 0);
    store.updateMessageCountStmt = update;
    store.on('change', () => assert.equal(store.getUserSummary(userId).messageCount, store.exportUserMessages(userId).length));
    store.appendLiveMessage(message('new'));
    store.appendLiveMessage(message('new'));
    assert.equal(store.getMessageCount(userId), 2);
    assert.equal(changes, 1, 'duplicate insert emits no change');
  });
}

test('one user cannot start competing jobs across guilds or scans; deletion excludes new jobs', async t => {
  const store = memoryStore(t), manager = managerFor(store);
  let release;
  manager.client.rest.get = () => new Promise(resolve => { release = resolve; });
  const first = manager.startHeadless({ guildId, targetUserId: userId, limit: null });
  assert.equal(manager.startHeadless({ guildId: 'other-guild', targetUserId: userId, limit: null }).created, false);
  assert.equal(manager.startScan({ guildId: 'other-guild', targetUserIds: [userId], channelIds: [] }).created, 0);
  await tick();
  const deletion = manager.deleteUser(userId, { messagesOnly: true });
  assert.equal(manager.startHeadless({ guildId, targetUserId: userId, limit: null }).created, false);
  release({ messages: [], total_results: 0 });
  await deletion;
  assert.equal((await first.job.completion).cancelled, true);
  assert.equal(manager.getActiveJobCount(), 0);
  assert.equal(store.getMessageCount(userId), 0);
});

test('initial edit, event listeners and progress callback failures do not orphan jobs', async t => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args[0]));
  const store = memoryStore(t), manager = managerFor(store);
  manager.on('change', () => { throw Error('observer failed'); });
  const job = await manager.start({ targetUserId: userId, limit: null, interaction: {
    guildId, user: { id: 'admin' }, editReply: async () => { throw Error('edit failed'); }, fetchReply: async () => { throw Error('must not fetch'); },
  } });
  job.onProgress = async () => { throw Error('callback failed'); };
  assert.equal((await job.completion).ok, true);
  await tick();
  assert.equal(manager.jobs.size, 0);
  assert.equal(manager.runningCount, 0);
  assert.equal(store.getSavedDownloadJobs().length, 0);
  assert.ok(logs.some(x => x.includes('initial message')));
  assert.ok(logs.some(x => x.includes('progress callback')));
  manager.client.rest.get = async () => { throw Error('search failed'); };
  const failed = manager.startHeadless({ guildId, targetUserId: userId, limit: null, onProgress: () => { throw Error('callback failed'); } }).job;
  assert.equal((await failed.completion).ok, false);
  assert.equal(manager.jobs.size, 0);
});

test('stale, legacy and invalid-option trivia buttons cannot change or expire the current round', async t => {
  const store = memoryStore(t);
  setQuestion(store);
  const old = store.getActiveTriviaQuestion('channel').round_id;
  setQuestion(store);
  store.db.prepare('UPDATE trivia_active SET created_at = ?').run('2000-01-01T00:00:00Z');
  const current = store.getActiveTriviaQuestion('channel');
  for (const round of [old, null]) assert.equal(store.triviaAttempt(guildId, userId, 'correct', 'channel', round).status, 'stale_round');
  assert.equal(store.triviaAttempt(guildId, userId, 'invalid', 'channel', current.round_id).status, 'stale_round');
  for (const customId of [`trivia:${old}:correct`, 'trivia:correct']) {
    let reply;
    await handleTriviaButton({ customId, guildId, channelId: 'channel', user: { id: userId }, reply: async value => { reply = value; } }, { store });
    assert.match(reply.content, /old round/);
  }
  assert.deepEqual(store.getActiveTriviaQuestion('channel'), current);
  assert.equal(store.triviaGetLeaderboard(guildId).length, 0);
  store.restartTriviaClock('channel');
  assert.equal(store.getActiveTriviaQuestion('channel').round_id, current.round_id, 'clock restart does not invalidate buttons');
  const buttons = buildTriviaComponents(['correct'], new Map(), { roundId: current.round_id });
  assert.equal(buttons[0].components[0].data.custom_id, `trivia:${current.round_id}:correct`);
  assert.equal(store.triviaAttempt(guildId, userId, 'correct', 'channel', current.round_id).status, 'ok');
  assert.equal(store.triviaAttempt(guildId, userId, 'correct', 'channel', current.round_id).status, 'already_answered');
});

test('trivia answer defers before slow name resolution and wrong answer cannot overwrite a solved round', async t => {
  const store = memoryStore(t);
  setQuestion(store);
  const roundId = store.getActiveTriviaQuestion('channel').round_id;
  let acknowledged = 0, edits = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const guild = { members: { cache: new Map(), fetch: async () => { assert.ok(acknowledged); await gate; return null; } } };
  const interaction = guess => ({ customId: `trivia:${roundId}:${guess}`, guildId, channelId: 'channel', guild, user: { id: guess, username: guess },
    deferUpdate: async () => { acknowledged++; }, editReply: async () => { edits++; },
  });
  const wrong = handleTriviaButton(interaction('wrong'), { store });
  await tick();
  const correct = handleTriviaButton(interaction('correct'), { store });
  await tick();
  release();
  await Promise.all([wrong, correct]);
  assert.equal(acknowledged, 2);
  assert.equal(edits, 1);
  assert.equal(store.getActiveTriviaQuestion('channel'), null);
});

test('join and slash export acknowledge before slow work', async t => {
  const store = memoryStore(t), order = [];
  const interaction = { user: { id: userId }, inGuild: () => true, guild: {},
    options: { getString: () => 'voice', getBoolean: () => true, getUser: () => ({ id: userId }) },
    deferReply: async () => order.push('defer'), editReply: async () => order.push('edit'),
  };
  await joinCommand.execute({ interaction, config: { specialUserId: userId }, voiceManager: {
    resolveVoiceChannel: async () => { assert.equal(order[0], 'defer'); return { channel: { id: 'voice' } }; },
    join: async () => assert.equal(order[0], 'defer'),
  } });
  order.length = 0;
  t.mock.method(store, 'exportUserMessages', () => { assert.equal(order[0], 'defer'); return []; });
  await exportUserCommand.execute({ interaction, store, config: { specialUserId: userId } });
  assert.deepEqual(order, ['defer', 'edit']);
});

test('button/select failures are acknowledged and logged; fatal SQLite errors terminate', async t => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args[0]));
  for (const select of [false, true]) {
    let reply;
    await handleInteractionCreate({ customId: select ? 'scoreboard:sort' : 'download-cancel:bad',
      isStringSelectMenu: () => select, isButton: () => !select, isChatInputCommand: () => false,
      reply: async value => { reply = value; },
      deferUpdate: async () => { throw Error('select failed'); },
      values: ['points'], guildId,
    }, { downloadJobs: { handleButton: async () => { throw Error('button failed'); } } });
    assert.match(reply.content, /failed/);
  }
  assert.equal(logs.length, 2);
  const fatal = spawnSync(process.execPath, ['--input-type=module', '-e', "import {logError} from './src/services/errors.js'; const e = Error('database failed'); e.code = 'ERR_SQLITE_ERROR'; logError('fatal storage context', e);"], { encoding: 'utf8' });
  assert.notEqual(fatal.status, 0);
  assert.match(fatal.stderr, /fatal storage context/);
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(index, /GatewayIntentBits.GuildVoiceStates/);
  assert.equal((index.match(/\.catch\(error => logError/g) ?? []).length, 5);
});

test('/leave during delayed rejoin prevents reconnection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = new VoiceManager({ user: { id: 'bot' } });
  const channel = { id: 'voice', type: ChannelType.GuildVoice };
  const guild = { id: guildId, channels: { cache: new Map([['voice', channel]]) } };
  let joins = 0;
  manager.join = async () => { joins++; };
  manager.getConnection = () => null;
  manager.persistentTargets.set(guildId, 'voice');
  await manager.handleVoiceStateUpdate({ id: 'bot', guild, channelId: 'voice' }, { channelId: null });
  manager.leave(guildId);
  t.mock.timers.tick(1500);
  assert.equal(joins, 0);
  manager.persistentTargets.set(guildId, 'voice');
  await manager.handleVoiceStateUpdate({ id: 'bot', guild, channelId: 'voice' }, { channelId: null });
  t.mock.timers.tick(1500);
  assert.equal(joins, 1, 'unchanged persistent target still rejoins');
});

test('shared formatting obeys 1999/2000/2001 boundaries and retains full attachment text', t => {
  for (const length of [1999, 2000, 2001, 10000]) {
    const text = 'x'.repeat(length), payload = contentPayload(text);
    assert.ok(payload.content.length <= 2000);
    if (length <= 2000) assert.deepEqual(payload, { content: text });
    else assert.equal(payload.files[0].attachment.toString(), text);
  }
  const unicode = truncateContent('x'.repeat(1998) + '😀' + 'z');
  assert.ok(!/[\uD800-\uDBFF]$/.test(unicode.slice(0, -1)), 'do not split a surrogate pair');
  assert.equal(mentionList([], 'none', 'Users').content, 'none');
  const list = mentionList(Array(200).fill(userId), 'none', 'Users');
  assert.ok(list.content.length <= 2000);
  assert.equal(list.files[0].attachment.toString().split(`<@${userId}>`).length - 1, 200);
});

test('random-line, say, download-status and next-reply keep Discord payloads bounded', async t => {
  const replies = [], sends = [], long = 'x'.repeat(4000);
  const interaction = { user: { id: userId }, options: { getUser: () => ({ id: userId }), getString: key => key === 'message' ? long : null },
    reply: async value => replies.push(value), channel: { isTextBased: () => true, send: async value => sends.push(value) } };
  const config = { specialUserId: userId };
  await sayCommand.execute({ interaction, config });
  assert.ok(replies.at(-1).content.length < 100);
  assert.equal(sends.at(-1).files[0].attachment.toString(), long);
  await randomLineCommand.execute({ interaction, config, store: { getRandomMessageWithMetadata: () => ({ content: long }) } });
  assert.ok(replies.at(-1).content.length <= 2000);
  assert.ok(replies.at(-1).files[0].attachment.toString().endsWith(long));
  interaction.options.getUser = () => null;
  await downloadStatusCommand.execute({ interaction, config, downloadJobs: { getActiveJobs: () => Array(200).fill({ targetUserId: userId, status: 'queued', downloadedCount: 0, mediaSkipped: 0 }) } });
  assert.ok(replies.at(-1).content.length <= 2000);
  assert.equal(replies.at(-1).files[0].attachment.toString().split('\n').length, 201);
  const queue = new NextReplyQueue();
  await nextReplyCommand.execute({ interaction, config, nextReplyQueue: queue });
  assert.ok(replies.at(-1).content.length < 100);
  assert.equal(queue.list()[0].message, long);
  for (let i = 1; i < 50; i++) queue.enqueue({ message: 'x' });
  await nextReplyCommand.execute({ interaction, config, nextReplyQueue: queue });
  assert.match(replies.at(-1).content, /queue is full/);
});

test('source cache survives settings changes, invalidates on messages, and runtime settings notify only config', t => {
  const store = memoryStore(t);
  store.addDownloadedMessages(userId, [message('old')]);
  const cached = store.getMessageSources();
  store.setNerded(userId, true);
  store.setTracked(userId, true);
  store.setUserReplyChanceOverride(userId, 5);
  assert.equal(store.getMessageSources(), cached);
  const changes = [];
  store.on('change', change => changes.push(change));
  for (const key of ['trivia_timeout_seconds', 'trivia_option_count', 'trivia_bonus_seconds', 'reply_delay_seconds', 'typing_indicator']) store.setMetadata(key, '1');
  store.setMetadata(`download_checkpoint:${userId}`, `${guildId}:123`);
  assert.equal(changes.length, 5);
  assert.ok(changes.every(change => change.type === 'config'));
  store.appendLiveMessage(message('new'));
  assert.notEqual(store.getMessageSources(), cached);
  const next = store.getMessageSources();
  store.deleteStoredMessages(userId);
  assert.notEqual(store.getMessageSources(), next);
});

test('queue shares a 64 MiB byte budget and 50 entry cap and releases both on consume/remove', () => {
  const queue = new NextReplyQueue(), bytes = Buffer.alloc(32 * 1024 * 1024);
  const a = queue.enqueue({ image: { data: bytes } }), b = queue.enqueue({ image: { data: bytes } });
  assert.equal(queue.totalBytes, 64 * 1024 * 1024);
  assert.throws(() => queue.enqueue({ message: 'é' }), /queue is full/);
  queue.remove(a.id);
  assert.equal(queue.totalBytes, bytes.length);
  assert.equal(queue.consume(userId).id, b.id);
  assert.equal(queue.totalBytes, 0);
  for (let i = 0; i < 50; i++) queue.enqueue({ message: 'é' });
  assert.equal(queue.totalBytes, 100, 'UTF-8 bytes, not characters');
  assert.throws(() => queue.enqueue({ message: 'x' }), /queue is full/);
  queue.consume(userId);
  queue.enqueue({ message: 'x' });
  assert.equal(queue.size(), 50);
});

test('trivia fetches only chosen option members and preserves nickname/global left-user fallbacks', async t => {
  const store = memoryStore(t), fetched = [], resolved = [];
  for (let i = 0; i < 20; i++) { const id = String(i); store.setTracked(id, true); store.addDownloadedMessages(id, [{ ...message(`message-${i}`), content: 'hello' }]); }
  const guild = { members: { cache: new Map(), fetch: async id => { assert.notEqual(id, undefined); fetched.push(id); return id === fetched[0] ? { displayName: 'Nickname', user: { globalName: 'Profile' } } : null; } } };
  let posted;
  await triviaCommand.execute({ store, interaction: { channelId: 'channel', guild,
    client: { users: { cache: new Map(), fetch: async id => { resolved.push(id); return { globalName: 'Left profile', username: 'Left' }; } } },
    deferReply: async () => {}, editReply: async value => { posted = value; return { edit: async () => {}, fetch: async () => ({ embeds: [] }) }; },
  } });
  const ids = JSON.parse(store.getActiveTriviaQuestion('channel').option_user_ids);
  assert.deepEqual(new Set(fetched), new Set(ids));
  assert.equal(fetched.length, store.getTriviaOptionCount());
  assert.equal(resolved.length, fetched.length - 1);
  const labels = posted.components.flatMap(row => row.components.map(button => button.data.label));
  assert.ok(labels.includes('Profile (Nickname)'));
  assert.ok(labels.includes('Left profile'));
});

test('web export uses one ordered snapshot query; queue capacity errors and bulk ID reads surface correctly', async t => {
  const store = memoryStore(t), queue = new NextReplyQueue();
  const rows = Array.from({ length: 1101 }, (_, i) => ({ ...message(String(i).padStart(5, '0'), 'x'.repeat(100)), createdAt: `2026-01-${String(1 + i % 3).padStart(2, '0')}T00:00:00Z` }));
  store.addDownloadedMessages(userId, rows);
  const expected = store.exportUserMessages(userId).map(row => `${row.created_at}\t${row.content}`).join('\n');
  let exports = 0;
  const originalExport = store.exportUserMessages.bind(store);
  t.mock.method(store, 'exportUserMessages', (...args) => { exports++; return originalExport(...args); });
  let reads = 0;
  const originalIds = store.listUserIds.bind(store);
  t.mock.method(store, 'listUserIds', () => { reads++; return originalIds(); });
  const server = startWebDashboard({ store, nextReplyQueue: queue, config: { webDashboardPort: 0, webDashboardHost: '127.0.0.1', webDashboardToken: 'test-secret', specialUserId: userId, guildId },
    downloadJobs: { deleteUser: async () => {} }, client: { guilds: { cache: new Map() }, users: { cache: new Map() } },
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const api = (url, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${url}`, { ...options, headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json', ...options.headers } });
  const result = await api(`/api/users/${userId}/export`);
  assert.equal(await result.text(), expected);
  assert.equal(exports, 1);
  for (let i = 0; i < 50; i++) queue.enqueue({ message: 'x' });
  const rejected = await api('/api/queue', { method: 'POST', body: JSON.stringify({ message: 'too many' }) });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /queue is full/);
  const bulk = await api('/api/users/bulk', { method: 'POST', body: JSON.stringify({ action: 'delete', userIds: [userId] }) });
  assert.equal(bulk.status, 200);
  assert.equal(reads, 1);
});

test('dashboard jobs refresh during a full refresh keeps the full state', async () => {
  const { runInNewContext } = await import('node:vm');
  const src = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8').split('\nfetch(')[0];
  const stub = new Proxy(function () {}, { get: (_, k) => k === 'value' ? '' : stub, apply: () => stub, set: () => true });
  const pending = {}, rendered = [];
  const fetch = url => new Promise(resolve => { pending[url.startsWith('/api/state') ? 'state' : 'jobs'] = () => resolve({ ok: true, status: 200, json: async () => url.startsWith('/api/state') ? { marker: 'full' } : { jobs: [] } }); });
  const { refresh, refreshJobs } = runInNewContext(src + ';render = d => rendered.push(d.marker); ({ refresh, refreshJobs })',
    { rendered, document: stub, window: { scrollX: 0, scrollY: 0, scrollTo() {} }, fetch, EventSource: function () {}, setTimeout, clearTimeout });
  const full = refresh(); await new Promise(r => setImmediate(r));
  const jobs = refreshJobs(); pending.state();
  for (let i = 0; i < 20 && !pending.jobs; i++) await new Promise(r => setImmediate(r));
  assert.deepEqual(rendered, ['full']);
  pending.jobs(); await Promise.all([full, jobs]);
});
