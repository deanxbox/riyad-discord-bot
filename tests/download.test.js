import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore } from '../src/services/data-store.js';
import { DownloadJobManager } from '../src/services/download-jobs.js';
import { DownloadCancelledError, downloadUserHistory, scanChannelsForUsers } from '../src/services/history-downloader.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'riyad-download-'));
const store = new DataStore(path.join(dir, 'test.sqlite'));
const guildId = '100', userId = '200';
const message = (id, content = `text-${id}`) => ({
  id: String(id), author: { id: userId }, content, channel_id: '300',
  timestamp: '2026-01-01T00:00:00.000Z',
});

try {
  let messages = Array.from({ length: 51 }, (_, i) => message(151 - i));
  const routes = [];
  const client = { rest: { get: async (route, { query: params }) => {
    assert.equal(route.includes('?'), false, 'all pages must share a bucket route');
    routes.push(params);
    assert.ok(Number(params.get('limit')) <= 25, 'do not exceed the existing supported page size');
    const page = messages.filter(item => (!params.has('max_id') || BigInt(item.id) < BigInt(params.get('max_id'))) &&
      (!params.getAll('channel_id').length || params.getAll('channel_id').includes(item.channel_id)))
      .slice(0, Number(params.get('limit')));
    const filtered = messages.filter(item => !params.getAll('channel_id').length || params.getAll('channel_id').includes(item.channel_id));
    return { total_results: filtered.length, messages: page.map(item => [item]) };
  } } };
  const download = (jobId, limit = null, onProgress = async () => {}) => downloadUserHistory({
    client, guildId, targetUserId: userId, limit, store, jobId, onProgress,
  });

  assert.equal((await download('full')).downloadedCount, 51);
  assert.equal(routes.length, 4, 'full search exhausts the cursor, including a final empty page');
  assert.equal(store.getUserDownloadCheckpoint(userId, guildId), '151');
  messages = [message(153), { ...message(152, ''), attachments: [{}] }, ...messages];
  routes.length = 0;
  assert.equal((await download('incremental')).downloadedCount, 52);
  assert.equal(routes.length, 1, 'refresh stops at the last complete checkpoint');
  assert.equal(store.getUserDownloadCheckpoint(userId, guildId), '153');
  assert.equal(store.getUserSummary(userId).messageCount, 52);
  assert.equal(store.getUserSummary(userId).mediaSkipped, 1);
  assert.ok(store.exportUserMessages(userId).some(item => item.message_id === '101'), 'older messages survive a refresh');

  const controller = new AbortController();
  messages = [message(154), ...messages];
  await assert.rejects(downloadUserHistory({
    client, guildId, targetUserId: userId, limit: null, store, jobId: 'cancelled',
    signal: controller.signal, onProgress: async () => controller.abort(),
  }), DownloadCancelledError);
  assert.equal(store.getUserDownloadCheckpoint(userId, guildId), '153', 'cancel cannot advance the checkpoint');
  assert.equal(store.getUserSummary(userId).messageCount, 52, 'cancel cannot replace or partially merge the archive');
  assert.equal((await download('limited', 1)).downloadedCount, 1);
  assert.equal(store.getUserDownloadCheckpoint(userId, guildId), null, 'a limited replacement is not complete');
  routes.length = 0;
  assert.equal((await download('full-again')).downloadedCount, 53);
  assert.equal(routes.length, 4, 'a later full run scans historical pages after a limited replacement');

  const contextual = Array.from({ length: 30 }, (_, i) => ({
    ...message(300 - i), author: { id: '201' },
  }));
  const cursors = [];
  const contextClient = { rest: { get: async (route, { query: params }) => {
    assert.equal(route.includes('?'), false);
    cursors.push(params.get('max_id'));
    const page = contextual.filter(item => !params.has('max_id') || BigInt(item.id) < BigInt(params.get('max_id')))
      .slice(0, 25);
    return { total_results: 30, messages: [...page.map(item => [item]), ...(page.length ? [[message(1)]] : [])] };
  } } };
  assert.equal((await downloadUserHistory({
    client: contextClient, guildId, targetUserId: '201', limit: null, store,
    jobId: 'context', onProgress: async () => {},
  })).downloadedCount, 30);
  assert.equal(cursors[1], '276', 'search context must not move the cursor past matching messages');
  store.incrementMediaSkipped(userId);
  assert.equal(store.getUserDownloadCheckpoint(userId, guildId), null,
    'unidentified live media invalidates a checkpoint to prevent double counting');
  routes.length = 0;
  assert.equal((await download('after-live-media')).mediaSkipped, 1);
  assert.equal(routes.length, 4, 'a checkpoint invalidated by live media forces a complete scan');
  const previousCheckpoint = store.getUserDownloadCheckpoint(userId, guildId);
  const fullMessages = messages;
  messages = [message(155)];
  await download('sparse-search');
  assert.equal(store.getUserDownloadCheckpoint(userId, guildId), previousCheckpoint,
    'an incomplete search must not advance beyond unseen older messages');
  assert.equal(store.getUserSummary(userId).messageCount, 54, 'partial search still safely merges new messages');
  messages = [
    { ...message(400), author: { id: '202' }, channel_id: '301' },
    { ...message(300), author: { id: '202' }, channel_id: '300' },
  ];
  const firstScoped = await downloadUserHistory({
    client, guildId, targetUserId: '202', channelIds: ['301'], limit: null, store, jobId: 'first-scoped',
    onProgress: async () => {},
  });
  assert.equal(firstScoped.downloadedCount, 1);
  assert.equal(store.getUserDownloadCheckpoint('202', guildId), null, 'a first scoped search must not create a full-guild checkpoint');
  await downloadUserHistory({ client, guildId, targetUserId: '202', limit: null, store, jobId: 'first-unscoped', onProgress: async () => {} });
  assert.equal(store.getUserSummary('202').messageCount, 2, 'a later unscoped run still finds other-channel history');
  assert.ok(store.exportUserMessages('202').some(item => item.channel_id === '300'));
  const scopedCheckpoint = store.getUserDownloadCheckpoint(userId, guildId);
  messages = [message(200), { ...message(199), channel_id: '301' }];
  routes.length = 0;
  const scoped = await downloadUserHistory({
    client, guildId, targetUserId: userId, channelIds: ['301'], limit: null, store, jobId: 'scoped',
    onProgress: async () => {},
  });
  assert.equal(scoped.downloadedCount, 55, 'scoped search adds only selected-channel messages to the existing archive');
  assert.equal(routes[0].get('channel_id'), '301');
  assert.equal(store.getUserDownloadCheckpoint(userId, guildId), scopedCheckpoint, 'scoped search preserves the full-guild checkpoint');
  assert.ok(store.exportUserMessages(userId).some(item => item.channel_id === '300'), 'scoped search preserves messages from other channels');
  assert.ok(store.exportUserMessages(userId).some(item => item.channel_id === '301'), 'scoped search merges selected-channel messages');
  assert.ok(routes.every(params => params.getAll('channel_id').join(',') === '301'), 'selected channels are sent on every search page');
  messages = [message(155), ...fullMessages];

  let indexingCalls = 0;
  const indexingAbort = new AbortController();
  await assert.rejects(downloadUserHistory({
    client: { rest: { get: async () => {
      indexingCalls++;
      return { code: 110000, retry_after: 60, documents_indexed: 10 };
    } } },
    guildId, targetUserId: userId, limit: null, store, jobId: 'indexing',
    signal: indexingAbort.signal, onProgress: async () => indexingAbort.abort(),
  }), DownloadCancelledError);
  assert.equal(indexingCalls, 1, 'indexing backoff must stop promptly when cancelled');

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let inFlight = 0, peak = 0;
  const manager = new DownloadJobManager({
    client: { rest: { get: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight--;
      return { total_results: 0, messages: [] };
    } } },
    config: {}, store,
  });
  const selectedChannels = ['300'];
  const jobs = Array.from({ length: 4 }, (_, i) => manager.startHeadless({
    guildId, requestedById: userId, targetUserId: String(400 + i), limit: null,
    ...(i === 0 ? { channelIds: selectedChannels } : {}),
  }).job);
  selectedChannels.push('301');
  assert.deepEqual(jobs[0].channelIds, ['300'], 'queued jobs snapshot channel selection');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.runningCount, 3, 'only three jobs run concurrently');
  assert.equal(peak, 1, 'shared limiter serializes search requests across jobs');
  assert.equal(jobs[3].status, 'queued');
  assert.equal(manager.cancelJob(guildId, '403').cancelled, true);
  assert.equal((await jobs[3].completion).cancelled, true, 'queued cancellation resolves without waiting for a slot');
  release();
  await Promise.all(jobs.slice(0, 3).map(job => job.completion));
  assert.equal(peak, 1);

  // Restart: a job interrupted mid-download resumes from its saved cursor, not from scratch.
  messages = Array.from({ length: 60 }, (_, i) => message(1060 - i));
  const first = new DownloadJobManager({ client, config: {}, store });
  const crash = first.createJob({ guildId, requestedById: userId, targetUserId: userId, limit: null });
  store.saveDownloadJob(crash);
  const cut = new AbortController();
  await assert.rejects(downloadUserHistory({
    client, guildId, targetUserId: userId, limit: null, store, jobId: crash.id, signal: cut.signal,
    onProgress: async p => { if (p.requestsMade === 1) { crash.resume = store.getSavedDownloadJobs()[0].resume; cut.abort(); } },
  }), DownloadCancelledError);
  // abort discards staging like a cancel; simulate a hard kill by re-staging what a page would have saved
  store.beginStagedUserDownload(crash.id, userId);
  store.addStagedDownloadedMessages(crash.id, userId, [{ messageId: '1060', userId, guildId, channelId: '300', content: 'x', createdAt: 'z' }],
    { maxId: '1060', scannedCount: 1, mediaSkipped: 0, newestId: '1060', totalResults: 60, requestsMade: 1, checkpoint: null, reachedCheckpoint: false });
  const second = new DownloadJobManager({ client, config: {}, store });
  second.resumeSavedJobs();
  const resumed = second.getActiveJob(guildId, userId);
  assert.equal(resumed.id, crash.id);
  assert.equal(resumed.downloadedCount, 1);
  await resumed.completion;
  assert.equal(store.getSavedDownloadJobs().length, 0, 'finished jobs are removed from persistence');
  assert.equal(store.exportUserMessages(userId).length, 60, 'resume yields the full archive without duplicates');
  // Shared channel scan: one pass over the channel serves every selected user.
  const scanAuthors = ['501', '502', '503'];
  const channelMessages = Array.from({ length: 250 }, (_, i) => ({
    id: String(2000 - i), author: { id: scanAuthors[i % 3] }, content: i % 10 === 0 ? '' : `scan-${i}`,
    attachments: i % 10 === 0 ? [{}] : [], channel_id: '700', timestamp: '2026-01-01T00:00:00.000Z',
  }));
  const scanRequests = [];
  const scanClient = { rest: { get: async (route, { query: params }) => {
    scanRequests.push(params.get('before'));
    assert.equal(params.get('limit'), '100');
    return channelMessages.filter(item => !params.has('before') || BigInt(item.id) < BigInt(params.get('before'))).slice(0, 100);
  } } };
  const never = new AbortController().signal, stop = new AbortController();
  const scan = await scanChannelsForUsers({
    client: scanClient, guildId, channelIds: ['700'], store,
    targets: [{ userId: '501', jobId: 'scan-501', signal: never }, { userId: '502', jobId: 'scan-502', signal: never }, { userId: '503', jobId: 'scan-503', signal: stop.signal }],
    onProgress: async () => stop.abort(),
  });
  assert.equal(scanRequests.length, 3, 'one pass over the channel serves every user');
  assert.equal(scan.results.find(r => r.userId === '503').cancelled, true, 'a cancelled user is dropped without stopping the others');
  assert.equal(store.getUserSummary('503').messageCount, 0);
  assert.equal(store.getUserSummary('501').messageCount + store.getUserSummary('502').messageCount, 150, 'selected users get their text messages');
  assert.equal(store.exportUserMessages('501')[0].guild_id, guildId, 'scanned rows record the server');
  console.log('Download self-check passed: paging, incremental refresh, cancellation, and bounded jobs.');
} finally {
  store.close();
  await fs.rm(dir, { recursive: true, force: true });
}
