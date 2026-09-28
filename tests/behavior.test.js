import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { sayCommand } from '../src/commands/say.js';
import { DataStore, isTriviaExpired } from '../src/services/data-store.js';
import { startWebDashboard } from '../src/web/server.js';

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
    server = startWebDashboard({
      config, store, downloadJobs: { getActiveJobs: () => [] },
      nextReplyQueue: { list: () => [] },
    });
    if (!server.listening) await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = (route, options = {}) => fetch(base + route, {
      ...options, headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
    });
    assert.equal((await fetch(base + '/api/state')).status, 401);
    assert.equal((await fetch(base + '/api/backup')).status, 401);
    assert.equal((await fetch(base + '/api/settings', { method: 'POST' })).status, 401);
    assert.equal((await api('/api/settings', {
      method: 'POST', body: JSON.stringify({ reactionChanceDenominator: '8' }),
    })).status, 200);
    assert.equal((await (await api('/api/state')).json()).reactionChanceDenominator, 8);

    store.setTracked('123456789012345678', true);
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
