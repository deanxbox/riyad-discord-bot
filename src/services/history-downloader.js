import { Routes } from 'discord-api-types/v10';

const SEARCH_INDEX_NOT_READY_CODE = 110000;
const PAGE_SIZE = 25;

export class DownloadCancelledError extends Error {
  constructor(message = 'Download cancelled.') {
    super(message);
    this.name = 'DownloadCancelledError';
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

function buildSearchQuery({ targetUserId, limit, maxId }) {
  const params = new URLSearchParams();

  params.set('limit', String(limit));
  params.set('sort_by', 'timestamp');
  params.set('sort_order', 'desc');
  params.append('author_id', targetUserId);

  if (maxId) {
    params.set('max_id', maxId);
  }

  return params.toString();
}

async function fetchSearchPage({ client, guildId, targetUserId, pageSize, maxId, signal, onIndexing }) {
  while (true) {
    throwIfCancelled(signal);

    const route = `${Routes.guildMessagesSearch(guildId)}?${buildSearchQuery({
      targetUserId,
      limit: pageSize,
      maxId,
    })}`;

    const response = await client.rest.get(route);

    if (response?.code !== SEARCH_INDEX_NOT_READY_CODE) {
      return response;
    }

    const retryAfterSeconds = Number(response.retry_after ?? 0);

    await onIndexing({
      retryAfterSeconds,
      documentsIndexed: Number(response.documents_indexed ?? 0),
    });

    await delay(Math.max(250, retryAfterSeconds * 1000));
  }
}

export async function downloadUserHistory({
  client,
  guildId,
  targetUserId,
  limit,
  store,
  jobId,
  signal,
  onProgress,
}) {
  let downloadedCount = 0;
  let mediaSkipped = 0;
  let scannedCount = 0;
  let discoveredTotalResults = null;
  let requestsMade = 0;
  let maxId = null;

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
        signal,
        onIndexing: async ({ retryAfterSeconds, documentsIndexed }) => {
          await onProgress({
            status: 'indexing',
            downloadedCount,
            mediaSkipped,
            totalResults: discoveredTotalResults,
            requestsMade,
            lastPageCount: 0,
            retryAfterSeconds,
            documentsIndexed,
          });
        },
      });

      requestsMade += 1;

      if (typeof response.total_results === 'number') {
        discoveredTotalResults = response.total_results;
      }

      const searchMessages = flattenSearchMessages(response.messages);

      if (searchMessages.length === 0) {
        await onProgress({
          status: 'running',
          downloadedCount,
          mediaSkipped,
          totalResults: discoveredTotalResults,
          requestsMade,
          lastPageCount: 0,
        });
        break;
      }

      const targetMessages = searchMessages.filter((message) => message?.author?.id === targetUserId).slice(0, pageSize);
      scannedCount += targetMessages.length;
      const matchingMessages = targetMessages.filter((message) => classifySearchMessage(message, targetUserId) === 'text').map(toStoredMessage);
      mediaSkipped += targetMessages.filter((message) => classifySearchMessage(message, targetUserId) === 'media-only').length;

      const insertedCount = store.addStagedDownloadedMessages(jobId, targetUserId, matchingMessages);
      downloadedCount += insertedCount;
      maxId = searchMessages.at(-1)?.id ?? null;

      await onProgress({
        status: 'running',
        downloadedCount,
        mediaSkipped,
        totalResults: discoveredTotalResults,
        requestsMade,
        lastPageCount: insertedCount,
      });

      const targetTotal = limit === null
        ? discoveredTotalResults
        : discoveredTotalResults === null
          ? limit
          : Math.min(discoveredTotalResults, limit);

      if (!maxId || (targetTotal !== null && scannedCount >= targetTotal)) {
        break;
      }
    }

    throwIfCancelled(signal);

    const finalCount = store.commitStagedUserDownload(jobId, targetUserId, mediaSkipped);

    return {
      downloadedCount: finalCount,
      mediaSkipped,
      totalResults: discoveredTotalResults,
      requestsMade,
    };
  } catch (error) {
    store.discardStagedUserDownload(jobId);
    throw error;
  }
}
