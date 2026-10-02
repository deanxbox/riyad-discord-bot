import { Routes } from 'discord-api-types/v10';

const SEARCH_INDEX_NOT_READY_CODE = 110000;
const PAGE_SIZE = 25;
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

function toStoredMessage(message) {
  return {
    messageId: message.id,
    userId: message.author.id,
    guildId: message.guild_id ?? message.guildId ?? null,
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
}) {
  let downloadedCount = 0;
  let mediaSkipped = 0;
  let scannedCount = 0;
  let discoveredTotalResults = null;
  let requestsMade = 0;
  let maxId = null;
  let newestId = null;
  const scoped = channelIds.length > 0;
  const checkpoint = limit === null && !scoped ? store.getUserDownloadCheckpoint(targetUserId, guildId) : null;
  let exhausted = false;
  let reachedCheckpoint = false;

  throwIfCancelled(signal);
  store.beginStagedUserDownload(jobId, targetUserId);

  try {
    while (limit === null || scannedCount < limit) {
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
      const matchingMessages = targetMessages.filter((message) => classifySearchMessage(message, targetUserId) === 'text').map(toStoredMessage);
      mediaSkipped += targetMessages.filter((message) => classifySearchMessage(message, targetUserId) === 'media-only').length;

      const insertedCount = store.addStagedDownloadedMessages(jobId, targetUserId, matchingMessages);
      downloadedCount += insertedCount;
      const nextMaxId = pageMessages.at(-1)?.id ?? null;
      if (maxId && nextMaxId && BigInt(nextMaxId) >= BigInt(maxId)) {
        throw new Error('Discord search pagination did not advance.');
      }
      maxId = nextMaxId;
      reachedCheckpoint = Boolean(checkpoint && maxId && BigInt(maxId) <= BigInt(checkpoint));

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
