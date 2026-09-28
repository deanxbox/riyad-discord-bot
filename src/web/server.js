import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const page = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Riyad dashboard</title>
<style>
body{font:16px system-ui,sans-serif;max-width:850px;margin:2rem auto;padding:0 1rem;background:#151821;color:#f5f5fa}
input,button{font:inherit;padding:.45rem;margin:.25rem;background:#282e3c;color:inherit;border:1px solid #70788c;border-radius:5px}
button{cursor:pointer}button:hover{background:#3c465c}section{padding:1rem;margin:1rem 0;background:#222837;border-radius:8px}
label{display:inline-block;margin:.3rem}li{margin:.5rem 0}#error{color:#ffaaa7;white-space:pre-wrap}
</style>
<h1>Riyad dashboard</h1>
<label>Dashboard token <input id="token" type="password" autocomplete="off"></label>
<button id="connect">Connect</button><p id="error" role="alert"></p>
<main hidden><button id="refresh">Refresh status</button>
<section><h2>Global settings</h2>
<label>Default reply chance (%) <input id="reply" type="number" min="0" max="100"></label><button data-setting="replyChancePercent" data-input="reply">Save</button><br>
<label>Reaction chance (1 in N) <input id="reaction" type="number" min="1" max="1000000"></label><button data-setting="reactionChanceDenominator" data-input="reaction">Save</button><br>
<label>Always-reply user ID <input id="always" inputmode="numeric"></label><button data-setting="alwaysReplyUserId" data-input="always">Save</button><button data-setting="alwaysReplyUserId" data-reset="true">Reset to .env</button><br>
<label>Nerd emoji <input id="emoji"></label><button data-setting="nerdEmoji" data-input="emoji">Save</button><button data-setting="nerdEmoji" data-reset="true">Reset to .env</button>
<p>Saved settings persist in SQLite; reset restores the configured environment default.</p></section>
<section><h2>Users</h2><label>User ID <input id="userId" inputmode="numeric"></label><button id="lookup">Find user</button><ul id="users"></ul></section>
<section><h2>Active downloads</h2><ul id="jobs"></ul></section>
<section><h2>Next replies</h2><ul id="queue"></ul></section>
<section><h2>Trivia leaderboard</h2><label>Guild ID <input id="guildId" inputmode="numeric"></label><button id="leaderboard">Load</button><ol id="scores"></ol></section>
<section><h2>Database backup</h2><button id="backup">Download SQLite snapshot</button></section>
</main>
<script>
let token = '';
const $ = id => document.getElementById(id);
const text = (tag, value) => { const el = document.createElement(tag); el.textContent = value; return el; };
async function api(route, options = {}) {
  const response = await fetch(route, {
    ...options,
    headers: { Authorization: 'Bearer ' + token, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (!response.ok) throw new Error((await response.text()).slice(0, 200));
  return response;
}
async function refresh() {
  const state = await (await api('/api/state?guildId=' + encodeURIComponent($('guildId').value) +
    '&userId=' + encodeURIComponent($('userId').value))).json();
  $('reply').value = state.replyChancePercent;
  $('reaction').value = state.reactionChanceDenominator;
  $('always').value = state.alwaysReplyUserId;
  $('emoji').value = state.nerdEmoji;
  const users = $('users'); users.replaceChildren();
  for (const user of state.users) {
    const li = text('li', user.userId + ' (' + user.messageCount + ' messages) ');
    for (const key of ['tracked', 'nerded']) {
      const button = text('button', key + ': ' + (user[key] ? 'on' : 'off'));
      button.onclick = () => run(async () => {
        await api('/api/users/' + user.userId, { method: 'POST', body: JSON.stringify({ [key]: !user[key] }) });
        await refresh();
      });
      li.append(button);
    }
    const chance = document.createElement('input');
    chance.type = 'number'; chance.min = '0'; chance.max = '100';
    chance.placeholder = 'inherit'; chance.title = 'Reply chance; blank to inherit';
    chance.value = user.replyChanceOverride ?? '';
    const save = text('button', 'Save chance');
    save.onclick = () => run(async () => {
      await api('/api/users/' + user.userId, { method: 'POST', body: JSON.stringify({ replyChanceOverride: chance.value === '' ? null : Number(chance.value) }) });
      await refresh();
    });
    li.append(chance, save); users.append(li);
  }
  for (const [id, rows, format] of [
    ['jobs', state.jobs, j => j.targetUserId + ': ' + j.status + ' (' + j.downloadedCount + ' downloaded)'],
    ['queue', state.queue, q => (q.targetUserId || 'any user') + ': ' + q.message],
    ['scores', state.leaderboard, s => s.user_id + ': ' + s.score],
  ]) $(id).replaceChildren(...rows.map(row => text('li', format(row))));
  $('error').textContent = '';
}
async function run(task) { try { await task(); } catch (error) { $('error').textContent = error.message; } }
$('connect').onclick = () => run(async () => {
  token = $('token').value; $('token').value = '';
  await refresh(); document.querySelector('main').hidden = false;
});
$('lookup').onclick = () => run(async () => {
  const id = $('userId').value;
  if (!/^\\d{17,20}$/.test(id)) throw new Error('Enter a valid Discord user ID.');
  await refresh();
});
$('leaderboard').onclick = () => run(refresh);
// ponytail: manual refresh; add polling if live job progress becomes necessary.
$('refresh').onclick = () => run(refresh);
document.querySelectorAll('[data-setting]').forEach(button => button.onclick = () => run(async () => {
  const value = button.dataset.reset ? null : $(button.dataset.input).value;
  await api('/api/settings', { method: 'POST', body: JSON.stringify({ [button.dataset.setting]: value }) });
  await refresh();
}));
$('backup').onclick = () => run(async () => {
  const blob = await (await api('/api/backup')).blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = 'bot-backup.sqlite'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
});
</script></html>`;

function authorized(request, secret) {
  const supplied = request.headers.authorization;
  if (typeof supplied !== 'string' || !supplied.startsWith('Bearer ')) return false;
  const expected = createHash('sha256').update(secret).digest();
  const received = createHash('sha256').update(supplied.slice(7)).digest();
  return timingSafeEqual(expected, received);
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 4096) throw new RangeError('Request body too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function startWebDashboard({ config, store, downloadJobs, nextReplyQueue }) {
  if (!config.webDashboardToken) {
    throw new Error('WEB_DASHBOARD_TOKEN is required when WEB_DASHBOARD_ENABLED=true.');
  }
  if (!Number.isInteger(config.webDashboardPort) || config.webDashboardPort < 0 || config.webDashboardPort > 65535) {
    throw new RangeError('WEB_DASHBOARD_PORT must be a valid TCP port.');
  }

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(page);
      return;
    }
    if (!pathname.startsWith('/api/')) { json(response, 404, { error: 'Not found' }); return; }
    if (!authorized(request, config.webDashboardToken)) { json(response, 401, { error: 'Unauthorized' }); return; }

    try {
      if (pathname === '/api/state' && request.method === 'GET') {
        const params = new URL(request.url, 'http://localhost').searchParams;
        const guildId = params.get('guildId') || config.guildId;
        const userIds = new Set([...store.listTrackedUsers(), ...store.listNerdedUsers()]);
        const selectedUserId = params.get('userId');
        if (selectedUserId && /^\d{17,20}$/.test(selectedUserId)) userIds.add(selectedUserId);
        json(response, 200, {
          users: [...userIds].map(id => store.getUserSummary(id)),
          replyChancePercent: store.getReplyChancePercent(),
          reactionChanceDenominator: store.getReactionChanceDenominator(),
          alwaysReplyUserId: config.alwaysReplyUserId,
          nerdEmoji: config.nerdEmoji,
          jobs: downloadJobs.getActiveJobs().map(({ targetUserId, guildId, status, downloadedCount, totalResults }) =>
            ({ targetUserId, guildId, status, downloadedCount, totalResults })),
          queue: nextReplyQueue.list(),
          leaderboard: guildId && /^\d{17,20}$/.test(guildId) ? store.triviaGetLeaderboard(guildId) : [],
        });
        return;
      }
      const userMatch = /^\/api\/users\/(\d{17,20})$/.exec(pathname);
      if (userMatch && request.method === 'POST') {
        const data = await readBody(request);
        if (!data || typeof data !== 'object' || Array.isArray(data) ||
            Object.keys(data).some(k => !['tracked', 'nerded', 'replyChanceOverride'].includes(k)) ||
            (data.tracked !== undefined && typeof data.tracked !== 'boolean') ||
            (data.nerded !== undefined && typeof data.nerded !== 'boolean') ||
            (data.replyChanceOverride !== undefined && data.replyChanceOverride !== null &&
              (!Number.isInteger(data.replyChanceOverride) || data.replyChanceOverride < 0 || data.replyChanceOverride > 100))) {
          throw new RangeError('Invalid user settings.');
        }
        const id = userMatch[1];
        if (data.tracked !== undefined) store.setTracked(id, data.tracked);
        if (data.nerded !== undefined) store.setNerded(id, data.nerded);
        if (data.replyChanceOverride !== undefined) store.setUserReplyChanceOverride(id, data.replyChanceOverride);
        json(response, 200, store.getUserSummary(id));
        return;
      }
      if (pathname === '/api/settings' && request.method === 'POST') {
        const data = await readBody(request);
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1) {
          throw new RangeError('Supply one setting at a time.');
        }
        if ('replyChancePercent' in data) {
          const value = data.replyChancePercent;
          if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new RangeError('Percent must be 0–100.');
          const percent = Number(value);
          if (!Number.isInteger(percent) || percent > 100) throw new RangeError('Percent must be 0–100.');
          store.setReplyChancePercent(percent);
        } else if ('reactionChanceDenominator' in data) {
          const value = data.reactionChanceDenominator;
          if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new RangeError('Invalid denominator.');
          store.setReactionChanceDenominator(Number(value));
        } else if ('alwaysReplyUserId' in data) {
          config.alwaysReplyUserId = store.setAlwaysReplyUserId(data.alwaysReplyUserId);
        } else if ('nerdEmoji' in data) {
          config.nerdEmoji = store.setNerdEmoji(data.nerdEmoji);
        } else {
          throw new RangeError('Unknown setting.');
        }
        json(response, 200, { ok: true });
        return;
      }
      if (pathname === '/api/backup' && request.method === 'GET') {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'riyad-backup-'));
        const filename = path.join(dir, 'bot.sqlite');
        try {
          store.backupTo(filename);
          const stream = fs.createReadStream(filename);
          response.writeHead(200, {
            'Content-Type': 'application/vnd.sqlite3',
            'Content-Disposition': 'attachment; filename="bot-backup.sqlite"',
            'Cache-Control': 'no-store',
          });
          stream.on('error', (error) => { console.error('Backup stream failed', error); response.destroy(error); });
          response.on('close', () => stream.destroy());
          stream.on('close', () => { void fsp.rm(dir, { recursive: true, force: true }); });
          stream.pipe(response);
        } catch (error) {
          await fsp.rm(dir, { recursive: true, force: true });
          throw error;
        }
        return;
      }
      json(response, 404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof RangeError || error instanceof SyntaxError) {
        json(response, 400, { error: error.message });
      } else {
        console.error('Dashboard request failed', error);
        json(response, 500, { error: 'Internal error' });
      }
    }
  });
  server.listen(config.webDashboardPort, config.webDashboardHost, () => {
    console.log(`Web dashboard listening on http://${config.webDashboardHost}:${server.address().port}`);
  });
  return server;
}
