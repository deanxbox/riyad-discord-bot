import { Routes } from 'discord-api-types/v10';

const SEARCH_INDEX_NOT_READY_CODE = 110000;
const PAGE_SIZE = 25;
const CHANNEL_PAGE_SIZE = 100;
const TRANSIENT_RETRIES = 3;

export class DownloadCancelledError extends Error {
  constructor(message = 'Download cancelled.') {
    super(message);
    this.name = 'DownloadCancelledError';
  }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    function cancel() {
      clearTimeout(timer);
      reject(new DownloadCancelledError());
    }
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

// One gate for the search endpoint across every job. discord.js REST handles its own 429
// retries; keep other searches behind it and honor its response/rate-limit events.
export function createSearchLimiter(rest) {
  let tail = Promise.resolve();
  let blockedUntil = 0;
  let notifyActive = null;
  const waitFor = ms => {
    if (!Number.isFinite(ms) || ms <= 0) return;
    blockedUntil = Math.max(blockedUntil, Date.now() + Math.min(ms, 60000));
    // Surface discord.js's internal 429 wait to the job currently making the request.
    Promise.resolve(notifyActive?.(Math.ceil(ms / 1000))).catch(() => {});
  };
  rest.on?.('rateLimited', data => {
    if (data.global || data.route?.includes('/messages/search')) waitFor(data.retryAfter);
  });
  rest.on?.('response', (request, response) => {
    if (!request?.path?.includes('/messages/search')) return;
    const headers = response.headers;
    if (response.status === 429) waitFor(Number(headers.get('retry-after')) * 1000);
    else if (headers.get('x-ratelimit-remaining') === '0') waitFor(Number(headers.get('x-ratelimit-reset-after')) * 1000);
  });
  return async (run, signal, onWait = async () => {}) => {
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    try {
      await previous;
      throwIfCancelled(signal);
      const remaining = Math.max(0, blockedUntil - Date.now());
      if (remaining) { await onWait(Math.ceil(remaining / 1000)); await delay(remaining, signal); }
      throwIfCancelled(signal);
      notifyActive = onWait;
      return await run();
    } finally { notifyActive = null; release(); }
  };
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    throw new DownloadCancelledError();
  }
}

export function classifySearchMessage(message, targetUserId) {
  if (message?.author?.id !== targetUserId) return 'ignored';
  if (typeof message.content === 'string' && message.content.trim().length > 0) return 'text';
  if (message.attachments?.length || message.sticker_items?.length || message.embeds?.length) return 'media-only';
  return 'ignored';
}

function toStoredMessage(message, searchedGuildId = null) {
  return {
    messageId: message.id,
    userId: message.author.id,
    // Guild search results omit guild_id, so fall back to the guild that was searched.
    guildId: message.guild_id ?? message.guildId ?? searchedGuildId ?? null,
    channelId: message.channel_id ?? message.channelId,
    content: message.content,
    createdAt: message.timestamp ?? message.createdAt ?? new Date().toISOString(),
  };
}

function flattenSearchMessages(messageGroups) {
  const messages = [];
  const seenIds = new Set();

  for (const group of messageGroups ?? []) {
    for (const message of group ?? []) {
      if (!message?.id || seenIds.has(message.id)) {
        continue;
      }

      seenIds.add(message.id);
      messages.push(message);
    }
  }

  messages.sort((left, right) => {
    const leftId = BigInt(left.id);
    const rightId = BigInt(right.id);

    if (leftId === rightId) {
      return 0;
    }

    return leftId > rightId ? -1 : 1;
  });

  return messages;
}

function buildSearchQuery({ targetUserId, limit, maxId, channelIds = [] }) {
  const params = new URLSearchParams();

  params.set('limit', String(limit));
  params.set('sort_by', 'timestamp');
  params.set('sort_order', 'desc');
  params.append('author_id', targetUserId);
  for (const channelId of channelIds) params.append('channel_id', channelId);

  if (maxId) {
    params.set('max_id', maxId);
  }

  return params;
}

async function fetchSearchPage({ client, guildId, targetUserId, pageSize, maxId, channelIds, signal, onIndexing, onWait, searchRequest }) {
  let failures = 0;
  while (true) {
    throwIfCancelled(signal);

    let response;
    try {
      response = await (searchRequest
        ? searchRequest(() => client.rest.get(Routes.guildMessagesSearch(guildId), {
          query: buildSearchQuery({ targetUserId, limit: pageSize, maxId, channelIds }),
        }), signal, onWait)
        : client.rest.get(Routes.guildMessagesSearch(guildId), {
          query: buildSearchQuery({ targetUserId, limit: pageSize, maxId, channelIds }),
        }));
    } catch (error) {
      throwIfCancelled(signal);
      const status = error.status ?? error.statusCode ?? error.rawError?.status;
      if (failures >= TRANSIENT_RETRIES || (status && status !== 429 && status < 500)) throw error;
      const retry = status === 429 ? Number(error.retry_after ?? error.rawError?.retry_after) * 1000 : NaN;
      const base = Number.isFinite(retry) && retry > 0 ? Math.min(retry, 60000) : Math.min(500 * 2 ** failures, 4000);
      const waitMs = base + Math.random() * Math.min(1000, base / 4); // jitter
      failures++;
      await onWait(Math.ceil(waitMs / 1000));
      await delay(waitMs, signal);
      continue;
    }

    if (response?.code !== SEARCH_INDEX_NOT_READY_CODE) {
      return response;
    }

    const retryAfterSeconds = Number(response.retry_after ?? 1);
    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0 || retryAfterSeconds > 2147483) {
      throw new Error('Invalid Discord search indexing retry_after.');
    }

    await onIndexing({
      retryAfterSeconds,
      documentsIndexed: Number(response.documents_indexed ?? 0),
    });

    await delay(Math.max(250, retryAfterSeconds * 1000), signal);
  }
}

export async function downloadUserHistory({
  client,
  guildId,
  targetUserId,
  channelIds = [],
  limit,
  store,
  jobId,
  signal,
  onProgress,
  searchRequest,
  resume = null,
}) {
  const scoped = channelIds.length > 0;
  // `resume` is the cursor persisted with the staged rows by a previous run of this job.
  const checkpoint = resume ? resume.checkpoint : limit === null && !scoped ? store.getUserDownloadCheckpoint(targetUserId, guildId) : null;
  let downloadedCount = resume ? store.getStagedDownloadCount(jobId) : 0;
  let mediaSkipped = resume?.mediaSkipped ?? 0;
  let scannedCount = resume?.scannedCount ?? 0;
  let discoveredTotalResults = resume?.totalResults ?? null;
  let requestsMade = resume?.requestsMade ?? 0;
  let maxId = resume?.maxId ?? null;
  let newestId = resume?.newestId ?? null;
  let exhausted = false;
  let reachedCheckpoint = resume?.reachedCheckpoint ?? false;

  throwIfCancelled(signal);
  if (!resume) store.beginStagedUserDownload(jobId, targetUserId);

  try {
    while (!reachedCheckpoint && (limit === null || scannedCount < limit)) {
      throwIfCancelled(signal);

      const pageSize = limit === null ? PAGE_SIZE : Math.min(PAGE_SIZE, limit - scannedCount);
      const response = await fetchSearchPage({
        client,
        guildId,
        targetUserId,
        pageSize,
        maxId,
        channelIds,
        signal,
        searchRequest,
        onWait: async retryAfterSeconds => onProgress({
          status: 'rate_limited', downloadedCount, mediaSkipped,
          totalResults: checkpoint ? null : discoveredTotalResults, requestsMade,
          lastPageCount: 0, retryAfterSeconds,
        }),
        onIndexing: async ({ retryAfterSeconds, documentsIndexed }) => {
          await onProgress({
            status: 'indexing',
            downloadedCount,
            mediaSkipped,
            totalResults: checkpoint ? null : discoveredTotalResults,
            requestsMade,
            lastPageCount: 0,
            retryAfterSeconds,
            documentsIndexed,
          });
        },
      });
      throwIfCancelled(signal);

      requestsMade += 1;

      if (typeof response.total_results === 'number') {
        discoveredTotalResults = response.total_results;
      }

      const searchMessages = flattenSearchMessages(response.messages);

      if (searchMessages.length === 0) {
        exhausted = true;
        await onProgress({
          status: 'running',
          downloadedCount,
          mediaSkipped,
          totalResults: checkpoint ? null : discoveredTotalResults,
          requestsMade,
          lastPageCount: 0,
        });
        break;
      }

      const pageMessages = searchMessages.filter((message) => message?.author?.id === targetUserId &&
        (!channelIds.length || channelIds.includes(message.channel_id ?? message.channelId))).slice(0, pageSize);
      if (pageMessages.length === 0) {
        throw new Error('Discord search returned no messages from the requested author.');
      }
      newestId ??= pageMessages[0].id;
      const targetMessages = checkpoint
        ? pageMessages.filter((message) => BigInt(message.id) > BigInt(checkpoint))
        : pageMessages;
      scannedCount += targetMessages.length;
      const matchingMessages = targetMessages.filter((message) => classifySearchMessage(message, targetUserId) === 'text').map((message) => toStoredMessage(message, guildId));
      mediaSkipped += targetMessages.filter((message) => classifySearchMessage(message, targetUserId) === 'media-only').length;

      const nextMaxId = pageMessages.at(-1)?.id ?? null;
      if (maxId && nextMaxId && BigInt(nextMaxId) >= BigInt(maxId)) {
        throw new Error('Discord search pagination did not advance.');
      }
      maxId = nextMaxId;
      reachedCheckpoint = Boolean(checkpoint && maxId && BigInt(maxId) <= BigInt(checkpoint));
      const insertedCount = store.addStagedDownloadedMessages(jobId, targetUserId, matchingMessages, {
        maxId, scannedCount, mediaSkipped, newestId, totalResults: discoveredTotalResults, requestsMade, checkpoint, reachedCheckpoint,
      });
      downloadedCount += insertedCount;

      await onProgress({
        status: 'running',
        downloadedCount,
        mediaSkipped,
        totalResults: checkpoint ? null : discoveredTotalResults,
        requestsMade,
        lastPageCount: insertedCount,
        currentMessage: targetMessages.at(-1) ? {
          author: targetMessages.at(-1).author?.username || targetUserId,
          timestamp: targetMessages.at(-1).timestamp ?? targetMessages.at(-1).createdAt ?? null,
          content: String(targetMessages.at(-1).content ?? '').slice(0, 180),
        } : null,
      });

      if (!maxId || reachedCheckpoint ||
          (limit !== null && scannedCount >= limit)) {
        break;
      }
    }

    throwIfCancelled(signal);

    const finalCount = store.commitStagedUserDownload(jobId, targetUserId, mediaSkipped, {
      guildId,
      checkpoint,
      merge: scoped,
      newestId: !scoped && limit === null &&
        (reachedCheckpoint || (!checkpoint && exhausted &&
          (discoveredTotalResults === null || scannedCount >= discoveredTotalResults)))
        ? newestId : null,
    });
    const finalMediaSkipped = store.getUserSummary(targetUserId).mediaSkipped;

    return {
      downloadedCount: finalCount,
      mediaSkipped: finalMediaSkipped,
      totalResults: checkpoint ? finalCount + finalMediaSkipped : discoveredTotalResults,
      requestsMade,
      incremental: Boolean(checkpoint),
    };
  } catch (error) {
    store.discardStagedUserDownload(jobId);
    throw error;
  }
}

// One shared pass over each channel's history for many users at once. Cost scales with channel
// size, not user count, so it beats per-user search once several users are selected.
// Matches are staged per user and only merged into the archive when the pass finishes.
export async function scanChannelsForUsers({ client, guildId, channelIds, targets, store, onProgress = async () => {} }) {
  const users = new Map(targets.map(target => [target.userId, { ...target, mediaSkipped: 0, downloadedCount: 0 }]));
  const active = () => [...users.values()].filter(user => !user.signal.aborted);
  let requestsMade = 0, scannedCount = 0, skippedChannels = 0;
  for (const user of users.values()) store.beginStagedUserDownload(user.jobId, user.userId);

  try {
    for (const channelId of channelIds) {
      let before = null;
      while (active().length) {
        let page;
        try {
          const query = new URLSearchParams({ limit: String(CHANNEL_PAGE_SIZE) });
          if (before) query.set('before', before);
          page = await client.rest.get(Routes.channelMessages(channelId), { query });
        } catch (error) {
          const status = error.status ?? error.statusCode ?? error.rawError?.status;
          if (status === 403 || status === 404) { skippedChannels++; break; } // no access / deleted
          throw error;
        }
        requestsMade++;
        if (!Array.isArray(page) || page.length === 0) break;
        scannedCount += page.length;

        const matches = new Map();
        for (const message of page) {
          const user = users.get(message?.author?.id);
          if (!user || user.signal.aborted) continue;
          const kind = classifySearchMessage(message, user.userId);
          if (kind === 'text') {
            if (!matches.has(user.userId)) matches.set(user.userId, []);
            matches.get(user.userId).push(toStoredMessage(message, guildId));
          } else if (kind === 'media-only') user.mediaSkipped++;
        }
        for (const [userId, stored] of matches) {
          const user = users.get(userId);
          if (!user.signal.aborted) user.downloadedCount += store.addStagedDownloadedMessages(user.jobId, userId, stored);
        }

        const nextBefore = page.at(-1).id;
        if (before && BigInt(nextBefore) >= BigInt(before)) throw new Error('Discord channel pagination did not advance.');
        before = nextBefore;
        await onProgress({ requestsMade, scannedCount, skippedChannels, channelId, users });
        if (page.length < CHANNEL_PAGE_SIZE) break;
      }
      if (!active().length) break;
    }

    const results = [];
    for (const user of users.values()) {
      if (user.signal.aborted) {
        store.discardStagedUserDownload(user.jobId);
        results.push({ userId: user.userId, cancelled: true });
        continue;
      }
      const downloadedCount = store.commitStagedUserDownload(user.jobId, user.userId, 0, { guildId, merge: true });
      results.push({ userId: user.userId, cancelled: false, downloadedCount, mediaSkipped: store.getUserSummary(user.userId).mediaSkipped });
    }
    return { results, requestsMade, scannedCount, skippedChannels };
  } catch (error) {
    for (const user of users.values()) store.discardStagedUserDownload(user.jobId);
    throw error;
  }
}
