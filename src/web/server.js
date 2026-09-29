import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const snowflake = /^\d{17,20}$/;
// Discord's documented default-user-avatar CDN asset (index 0).
const defaultAvatarUrl = 'https://cdn.discordapp.com/embed/avatars/0.png';
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);
const SESSION_MS = 12 * 60 * 60 * 1000;

export function isSnowflake(value) { return typeof value === 'string' && snowflake.test(value); }
export function isStaticPathSafe(value) { return staticFiles.has(value); }
export function validateSetting(key, value) {
  if (key === 'replyChancePercent' && Number.isInteger(value) && value >= 0 && value <= 100) return value;
  if (key === 'reactionChanceDenominator' && Number.isInteger(value) && value >= 1 && value <= 1000000) return value;
  if (key === 'downloadConcurrency' && Number.isInteger(value) && value >= 1 && value <= 10) return value;
  if (key === 'triviaOptionCount' && Number.isInteger(value) && value >= 2 && value <= 10) return value;
  if (key === 'replyDelaySeconds' && typeof value === 'number' && value >= 0 && value <= 60) return value;
  if (key === 'typingIndicator' && typeof value === 'boolean') return value;
  if (['alwaysReplyUserId', 'specialUserId', 'specialRoleId'].includes(key) && isSnowflake(value)) return value;
  if (key === 'guildId' && (value === null || isSnowflake(value))) return value;
  if (key === 'nerdEmoji' && typeof value === 'string' && value.trim() && value.length <= 100) return value.trim();
  throw new RangeError('Invalid setting value.');
}

export function createUserResolver(client, { ttlMs = 60000, concurrency = 5 } = {}) {
  const cache = new Map(), pending = new Map(), queue = [];
  let active = 0;
  const drain = () => {
    while (active < concurrency && queue.length) {
      const task = queue.shift(); active++;
      Promise.resolve().then(task.run).finally(() => { active--; drain(); });
    }
  };
  const resolve = async id => {
    const cached = client.users.cache.get(id);
    const member = [...client.guilds.cache.values()].map(g => g.members.cache.get(id)).find(Boolean);
    const hit = cached || member?.user;
    if (hit) return userObject(id, hit, member);
    const prior = cache.get(id);
    if (prior && prior.expires > Date.now()) return prior.value;
    if (pending.has(id)) return pending.get(id);
    const promise = new Promise(resolvePromise => {
      queue.push({ run: async () => {
        try {
          const user = await client.users.fetch(id);
          const value = userObject(id, user);
          cache.set(id, { value, expires: Date.now() + ttlMs }); resolvePromise(value);
        } catch {
          const value = userObject(id);
          cache.set(id, { value, expires: Date.now() + ttlMs });
          resolvePromise(value);
        }
        finally { pending.delete(id); }
      } });
      drain();
    });
    pending.set(id, promise);
    return promise;
  };
  return resolve;
}

function userObject(id, user, member) {
  return { id, username: user?.username || id, displayName: member?.displayName || user?.globalName || user?.username || id, avatarUrl: user?.displayAvatarURL?.({ size: 64 }) || defaultAvatarUrl };
}
export function tokenMatches(supplied, secret) {
  return typeof supplied === 'string' && timingSafeEqual(createHash('sha256').update(secret).digest(), createHash('sha256').update(supplied).digest());
}
export function createSessionStore(now = Date.now) {
  // ponytail: sessions die on restart; use signed cookies or a persistent store if multi-process continuity is needed.
  const sessions = new Map();
  return {
    sessions,
    create() { const id = randomBytes(32).toString('hex'); sessions.set(id, now() + SESSION_MS); return id; },
    use(id) {
      if (!id || !sessions.has(id)) return false;
      if (sessions.get(id) <= now()) { sessions.delete(id); return false; }
      sessions.set(id, now() + SESSION_MS);
      return true;
    },
    valid(id) { return Boolean(id && sessions.has(id) && sessions.get(id) > now()); },
    destroy(id) { sessions.delete(id); },
    prune() { for (const [id, expires] of sessions) if (expires <= now()) sessions.delete(id); },
  };
}
export function sessionCookie(request, id = '', maxAge = 43200) {
  return `sid=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${request.socket.encrypted || request.headers['x-forwarded-proto']?.split(',')[0].trim().toLowerCase() === 'https' ? '; Secure' : ''}`;
}
export function csrfAllowed(request) {
  if (request.headers['x-requested-with'] !== 'dashboard') return false;
  if (!request.headers.origin) return true;
  try { return new URL(request.headers.origin).host === request.headers.host; }
  catch { return false; }
}
export function createLoginLimiter(now = Date.now) {
  const attempts = new Map();
  return {
    blocked(ip) { const entry = attempts.get(ip); return entry?.count >= 3 && entry.until > now(); },
    fail(ip) {
      const prior = attempts.get(ip);
      const count = prior && prior.until > now() ? prior.count + 1 : 1;
      attempts.set(ip, { count, until: now() + (count >= 3 ? 30000 : 60000) });
    },
    clear(ip) { attempts.delete(ip); },
    prune() { for (const [ip, entry] of attempts) if (entry.until <= now()) attempts.delete(ip); },
  };
}
function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}
async function readBody(request) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 65536) throw Object.assign(new RangeError('Request body too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new SyntaxError('Invalid JSON.'), { statusCode: 400 }); }
}
const resolved = async (resolve, id) => id ? resolve(String(id)) : null;

export function startWebDashboard({ config, store, downloadJobs, nextReplyQueue, client }) {
  if (!config.webDashboardToken) throw new Error('WEB_DASHBOARD_TOKEN is required when WEB_DASHBOARD_ENABLED=true.');
  if (!Number.isInteger(config.webDashboardPort) || config.webDashboardPort < 0 || config.webDashboardPort > 65535) throw new RangeError('WEB_DASHBOARD_PORT must be a valid TCP port.');
  const resolveUser = createUserResolver(client || { users: { cache: new Map(), fetch: async () => { throw Error(); } }, guilds: { cache: new Map() } });
  const started = Date.now();
  const sessions = createSessionStore(), limiter = createLoginLimiter(), streams = new Set();
  const publish = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of streams) if (!stream.write(payload)) stream.end();
  };
  const onStoreChange = change => publish(change.type, change);
  const onQueueChange = change => publish('queue', change);
  const onJobChange = change => publish('download', change);
  store.on?.('change', onStoreChange);
  nextReplyQueue?.on?.('change', onQueueChange);
  downloadJobs?.on?.('change', onJobChange);
  const heartbeat = setInterval(() => {
    for (const stream of streams) {
      if (stream.dashboardSession && !sessions.valid(stream.dashboardSession)) { stream.end(); continue; }
      stream.write(': heartbeat\n\n');
    }
  }, 25000);
  heartbeat.unref();
  const stats = setInterval(() => {
    if (streams.size) publish('stats', { uptime: Math.floor((Date.now() - started) / 1000), ping: client?.ws?.ping ?? null, tracked: store.getTrackedUsersCount(), storedMessages: store.getTotalStoredMessages(), mediaSkipped: store.getTotalMediaSkipped(), activeDownloads: downloadJobs.getActiveJobs().length });
  }, 5000);
  stats.unref();
  const pruning = setInterval(() => { sessions.prune(); limiter.prune(); }, 60000);
  pruning.unref();
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https://cdn.discordapp.com https://media.discordapp.net; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && isStaticPathSafe(pathname)) {
      try {
        const [name, type] = staticFiles.get(pathname);
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        fs.createReadStream(path.join(publicDir, name)).pipe(response);
      } catch { json(response, 404, { error: 'Not found' }); }
      return;
    }
    if (!pathname.startsWith('/api/')) { json(response, 404, { error: 'Not found' }); return; }
    try {
      const sid = /(?:^|;\s*)sid=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie || '')?.[1];
      const cookieAuth = sessions.use(sid);
      const bearer = request.headers.authorization;
      const bearerAuth = typeof bearer === 'string' && bearer.startsWith('Bearer ') && tokenMatches(bearer.slice(7), config.webDashboardToken);
      if (pathname === '/api/login' && request.method === 'POST') {
        if (!csrfAllowed(request)) { json(response, 403, { error: 'Forbidden' }); return; }
        const ip = request.socket.remoteAddress || 'unknown';
        if (limiter.blocked(ip)) { json(response, 429, { error: 'Too many login attempts.' }); return; }
        const body = await readBody(request);
        if (!tokenMatches(body?.token, config.webDashboardToken)) {
          limiter.fail(ip);
          json(response, 401, { error: 'Invalid token.' }); return;
        }
        limiter.clear(ip);
        if (sid) sessions.destroy(sid);
        response.setHeader('Set-Cookie', sessionCookie(request, sessions.create()));
        json(response, 200, { ok: true }); return;
      }
      if (!cookieAuth && !bearerAuth) { json(response, 401, { error: 'Unauthorized' }); return; }
      if (cookieAuth) response.setHeader('Set-Cookie', sessionCookie(request, sid));
      if (['POST', 'PUT', 'DELETE'].includes(request.method) && cookieAuth && !csrfAllowed(request)) { json(response, 403, { error: 'Forbidden' }); return; }
      if (pathname === '/api/session' && request.method === 'GET') { json(response, 200, { ok: true }); return; }
      if (pathname === '/api/logout' && request.method === 'POST') {
        if (sid) sessions.destroy(sid);
        for (const stream of streams) if (stream.dashboardSession === sid && sid) stream.end();
        response.setHeader('Set-Cookie', sessionCookie(request, '', 0));
        json(response, 200, { ok: true }); return;
      }
      if (pathname === '/api/events' && request.method === 'GET') {
        if (streams.size >= 20) { json(response, 503, { error: 'Too many live connections.' }); return; }
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.dashboardSession = cookieAuth ? sid : null;
        streams.add(response);
        response.write('retry: 3000\n\n');
        response.on('close', () => streams.delete(response));
        return;
      }
      const params = new URL(request.url, 'http://localhost').searchParams;
      if (pathname === '/api/state' && request.method === 'GET') {
        const guildId = params.get('guildId') || config.guildId;
        const ids = new Set(store.listUserIds());
        if (isSnowflake(params.get('userId'))) ids.add(params.get('userId'));
        const users = await Promise.all([...ids].map(async id => {
          const { userId, ...summary } = store.getUserSummary(id);
          return { ...summary, user: await resolveUser(id) };
        }));
        const jobs = await Promise.all(downloadJobs.getActiveJobs().map(async j => ({
          id: j.id, guildId: j.guildId, target: await resolveUser(j.targetUserId), requestedBy: await resolveUser(j.requestedById),
          status: j.status, downloadedCount: j.downloadedCount, mediaSkipped: j.mediaSkipped, totalResults: j.totalResults, limit: j.limit, retryAfterSeconds: j.retryAfterSeconds, currentMessage: j.currentMessage,
        })));
        const queue = await Promise.all(nextReplyQueue.list().map(async ({ targetUserId, createdByUserId, ...q }) => ({
          ...q, target: await resolved(resolveUser, targetUserId), createdBy: await resolveUser(createdByUserId),
        })));
        const leaderboard = guildId && isSnowflake(guildId) ? await Promise.all(store.triviaGetLeaderboard(guildId).map(async ({ user_id, ...row }) => ({ ...row, user: await resolveUser(user_id) }))) : [];
        json(response, 200, {
          users, jobs, queue, leaderboard,
          replyChancePercent: store.getReplyChancePercent(), reactionChanceDenominator: store.getReactionChanceDenominator(),
          downloadConcurrency: store.getDownloadConcurrency(),
          triviaOptionCount: store.getTriviaOptionCount(), replyDelaySeconds: store.getReplyDelaySeconds(), typingIndicator: store.getTypingIndicator(),
          alwaysReplyUser: await resolveUser(config.alwaysReplyUserId), nerdEmoji: config.nerdEmoji,
          specialUser: await resolveUser(config.specialUserId), specialRoleId: config.specialRoleId,
          specialRole: [...(client?.guilds?.cache?.values?.() || [])].map(g => g.roles.cache.get(config.specialRoleId)).find(Boolean)?.name || config.specialRoleId,
          guildId: config.guildId, guildName: client?.guilds?.cache?.get(config.guildId)?.name || config.guildId,
          guilds: [...(client?.guilds?.cache?.values?.() || [])].map(g => ({ id: g.id, name: g.name })),
          stats: { tracked: store.getTrackedUsersCount(), storedMessages: store.getTotalStoredMessages(), mediaSkipped: store.getTotalMediaSkipped(), activeDownloads: jobs.length, uptime: Math.floor((Date.now() - started) / 1000), ping: client?.ws?.ping ?? null },
        });
        return;
      }
      if (pathname === '/api/resolve' && request.method === 'GET') {
        const id = params.get('id');
        if (!isSnowflake(id)) throw new RangeError('Invalid Discord ID.');
        if (params.get('type') === 'role') {
          const role = [...(client?.guilds?.cache?.values?.() || [])].map(g => g.roles.cache.get(id)).find(Boolean);
          json(response, 200, { name: role?.name || id });
        } else json(response, 200, { user: await resolveUser(id) });
        return;
      }
      if (pathname === '/api/members' && request.method === 'GET') {
        const guildId = params.get('guildId'), query = params.get('query')?.trim();
        const guild = client?.guilds?.cache?.get(guildId);
        if (!isSnowflake(guildId) || !guild || !query || query.length > 64 || (!isSnowflake(query) && query.length < 2)) throw new RangeError('Invalid member search.');
        const members = isSnowflake(query)
          ? [await guild.members.fetch(query).catch(() => null)].filter(Boolean)
          : [...(await guild.members.search({ query, limit: 10 })).values()];
        json(response, 200, { members: members.map(member => userObject(member.id, member.user, member)) }); return;
      }
      const userMatch = /^\/api\/users\/(\d{17,20})$/.exec(pathname);
      if (userMatch && request.method === 'DELETE') {
        await downloadJobs.deleteUser(userMatch[1]);
        json(response, 200, { ok: true }); return;
      }
      if (userMatch && request.method === 'POST') {
        const data = await readBody(request);
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => !['tracked', 'nerded', 'replyChanceOverride', 'deleteMessages'].includes(k)) ||
          (data.tracked !== undefined && typeof data.tracked !== 'boolean') || (data.nerded !== undefined && typeof data.nerded !== 'boolean') ||
          (data.replyChanceOverride !== undefined && data.replyChanceOverride !== null && (!Number.isInteger(data.replyChanceOverride) || data.replyChanceOverride < 0 || data.replyChanceOverride > 100)) ||
          (data.deleteMessages !== undefined && data.deleteMessages !== true)) throw new RangeError('Invalid user settings.');
        const id = userMatch[1];
        if (data.tracked !== undefined) store.setTracked(id, data.tracked);
        if (data.nerded !== undefined) store.setNerded(id, data.nerded);
        if (data.replyChanceOverride !== undefined) store.setUserReplyChanceOverride(id, data.replyChanceOverride);
        if (data.deleteMessages) store.deleteStoredMessages(id);
        const { userId, ...summary } = store.getUserSummary(id);
        json(response, 200, { ...summary, user: await resolveUser(id) }); return;
      }
      if (pathname === '/api/settings' && request.method === 'POST') {
        const data = await readBody(request);
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1) throw new RangeError('Supply one setting at a time.');
        const [key] = Object.keys(data), value = validateSetting(key, data[key]);
        if (key === 'replyChancePercent') store.setReplyChancePercent(value);
        else if (key === 'reactionChanceDenominator') store.setReactionChanceDenominator(value);
        else if (key === 'downloadConcurrency') { store.setDownloadConcurrency(value); downloadJobs.drain(); }
        else if (key === 'triviaOptionCount') store.setTriviaOptionCount(value);
        else if (key === 'replyDelaySeconds') store.setReplyDelaySeconds(value);
        else if (key === 'typingIndicator') store.setTypingIndicator(value);
        else if (key === 'alwaysReplyUserId') config.alwaysReplyUserId = store.setAlwaysReplyUserId(value);
        else if (key === 'nerdEmoji') config.nerdEmoji = store.setNerdEmoji(value);
        else if (key === 'specialUserId') config.specialUserId = store.setDashboardSetting(key, value);
        else if (key === 'specialRoleId') config.specialRoleId = store.setDashboardSetting(key, value);
        else if (key === 'guildId') config.guildId = store.setDashboardSetting(key, value);
        json(response, 200, { ok: true }); return;
      }
      if (pathname === '/api/downloads' && request.method === 'GET') {
        const jobs = await Promise.all(downloadJobs.getActiveJobs().map(async j => ({ id: j.id, guildId: j.guildId, target: await resolveUser(j.targetUserId), requestedBy: await resolveUser(j.requestedById), status: j.status, downloadedCount: j.downloadedCount, mediaSkipped: j.mediaSkipped, totalResults: j.totalResults, limit: j.limit, retryAfterSeconds: j.retryAfterSeconds, currentMessage: j.currentMessage })));
        json(response, 200, { jobs }); return;
      }
      if (pathname === '/api/users/bulk' && request.method === 'POST') {
        const data = await readBody(request);
        if (!data || !['download', 'delete'].includes(data.action) ||
          !Array.isArray(data.userIds) || !data.userIds.length || data.userIds.length > 1000 ||
          new Set(data.userIds).size !== data.userIds.length || !data.userIds.every(isSnowflake) ||
          data.userIds.some(id => !store.listUserIds().includes(id)) ||
          (data.action === 'download' && (!isSnowflake(data.guildId) || !client?.guilds?.cache?.has(data.guildId)))) throw new RangeError('Invalid bulk request.');
        if (data.action === 'delete') {
          for (const id of data.userIds) await downloadJobs.deleteUser(id);
          json(response, 200, { deleted: data.userIds.length });
        } else {
          let started = 0;
          for (const id of data.userIds) {
            if (downloadJobs.startHeadless({ guildId: data.guildId, targetUserId: id, requestedById: config.specialUserId, limit: null }).created) started++;
          }
          json(response, 202, { started, skipped: data.userIds.length - started });
        }
        return;
      }
      if (pathname === '/api/downloads' && request.method === 'POST') {
        const data = await readBody(request);
        if (!data || !isSnowflake(data.userId) || !isSnowflake(data.guildId) || !(client?.guilds?.cache?.has(data.guildId)) ||
          (data.limit !== null && data.limit !== undefined && (!Number.isSafeInteger(data.limit) || data.limit < 1))) throw new RangeError('Invalid download request.');
        if (downloadJobs.getJobStatus(data.guildId, data.userId)) { json(response, 409, { error: 'A download is already active for this guild and user.' }); return; }
        const result = downloadJobs.startHeadless({ guildId: data.guildId, requestedById: config.specialUserId, targetUserId: data.userId, limit: data.limit ?? null });
        if (!result.created) { json(response, 409, { error: 'A download is already active for this guild and user.' }); return; }
        json(response, 202, { ok: true }); return;
      }
      const cancel = /^\/api\/downloads\/(\d{17,20})\/(\d{17,20})$/.exec(pathname);
      if (cancel && request.method === 'DELETE') {
        const result = downloadJobs.cancelJob(cancel[1], cancel[2]);
        if (!result.cancelled) { json(response, 404, { error: result.reason }); return; }
        json(response, 200, { ok: true }); return;
      }
      const line = /^\/api\/users\/(\d{17,20})\/random$/.exec(pathname);
      if (line && request.method === 'GET') { json(response, 200, { message: store.getRandomMessageWithMetadata(line[1]) }); return; }
      const exportMatch = /^\/api\/users\/(\d{17,20})\/export$/.exec(pathname);
      if (exportMatch && request.method === 'GET') {
        const rows = store.exportUserMessages(exportMatch[1]);
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${exportMatch[1]}.txt"`, 'Cache-Control': 'no-store' });
        response.end(rows.map(row => `${row.created_at}\t${row.content}`).join('\n')); return;
      }
      if (pathname === '/api/refresh-all' && request.method === 'POST') {
        const data = await readBody(request);
        if (!isSnowflake(data.guildId) || !client?.guilds?.cache?.has(data.guildId) ||
          (data.limit != null && (!Number.isSafeInteger(data.limit) || data.limit < 1))) throw new RangeError('Invalid refresh request.');
        void (async () => {
          for (const [i, userId] of store.listTrackedUsers().entries()) {
            if (i) await new Promise(resolve => setTimeout(resolve, 500));
            if (store.isTracked(userId) && !downloadJobs.getJobStatus(data.guildId, userId)) {
              const { job, created } = downloadJobs.startHeadless({ guildId: data.guildId, requestedById: config.specialUserId, targetUserId: userId, limit: data.limit ?? null });
              if (created) await job.completion;
            }
          }
        })().catch(() => {
          console.error('Dashboard refresh-all failed.');
        });
        json(response, 202, { ok: true }); return;
      }
      if (pathname === '/api/backup' && request.method === 'GET') {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'riyad-backup-')), filename = path.join(dir, 'bot.sqlite');
        try {
          store.backupTo(filename); const stream = fs.createReadStream(filename);
          response.writeHead(200, { 'Content-Type': 'application/vnd.sqlite3', 'Content-Disposition': 'attachment; filename="bot-backup.sqlite"', 'Cache-Control': 'no-store' });
          stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy());
          stream.on('close', () => { void fsp.rm(dir, { recursive: true, force: true }); }); stream.pipe(response);
        } catch (error) { await fsp.rm(dir, { recursive: true, force: true }); throw error; }
        return;
      }
      json(response, 404, { error: 'Not found' });
    } catch (error) {
      json(response, error.statusCode || (error instanceof RangeError || error instanceof SyntaxError ? 400 : 500),
        { error: error.statusCode === 413 ? 'Request body too large.' : error instanceof RangeError || error instanceof SyntaxError ? error.message : 'Internal error' });
    }
  });
  server.on('close', () => {
    clearInterval(pruning); clearInterval(heartbeat); clearInterval(stats);
    for (const stream of streams) stream.end();
    store.off?.('change', onStoreChange);
    nextReplyQueue?.off?.('change', onQueueChange);
    downloadJobs?.off?.('change', onJobChange);
  });
  server.liveClientCount = () => streams.size;
  const close = server.close.bind(server);
  server.close = callback => { for (const stream of streams) stream.end(); return close(callback); };
  server.listen(config.webDashboardPort, config.webDashboardHost, () => console.log(`Web dashboard listening on http://${config.webDashboardHost}:${server.address().port}`));
  return server;
}
