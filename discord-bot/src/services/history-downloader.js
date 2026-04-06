function shouldKeepMessage(message) {
  return typeof message.content === 'string' && message.content.trim().length > 0;
}

function toStoredMessage(message) {
  return {
    messageId: message.id,
    userId: message.author.id,
    guildId: message.guildId ?? null,
    channelId: message.channelId,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
  };
}

export async function downloadUserHistory({ guild, targetUserId, limit, store, onProgress }) {
  const channels = [...guild.channels.cache.values()].filter(
    (channel) => channel.viewable && typeof channel.messages?.fetch === 'function',
  );

  let downloadedCount = 0;
  let processedChannels = 0;
  let lastProgressUpdate = 0;

  store.startUserDownload(targetUserId);

  for (const channel of channels) {
    let before;
    let channelCount = 0;

    try {
      while (limit === null || downloadedCount < limit) {
        const remaining = limit === null ? 100 : Math.min(100, limit - downloadedCount);
        const batch = await channel.messages.fetch(before ? { limit: remaining, before } : { limit: remaining });

        if (batch.size === 0) {
          break;
        }

        const matchingMessages = [...batch.values()]
          .reverse()
          .filter((message) => message.author.id === targetUserId && shouldKeepMessage(message))
          .map(toStoredMessage);

        if (matchingMessages.length > 0) {
          store.addDownloadedMessages(targetUserId, matchingMessages);
          downloadedCount += matchingMessages.length;
          channelCount += matchingMessages.length;
        }

        before = batch.last()?.id;

        if (!before || batch.size < remaining) {
          break;
        }
      }
    } catch {
      processedChannels += 1;

      await onProgress({
        downloadedCount,
        processedChannels,
        totalChannels: channels.length,
        channelName: channel.name,
        channelCount: 0,
        skipped: true,
      });

      continue;
    }

    processedChannels += 1;
    const now = Date.now();

    if (now - lastProgressUpdate > 1200 || processedChannels === channels.length) {
      lastProgressUpdate = now;
      await onProgress({
        downloadedCount,
        processedChannels,
        totalChannels: channels.length,
        channelName: channel.name,
        channelCount,
        skipped: false,
      });
    }

    if (limit !== null && downloadedCount >= limit) {
      break;
    }
  }

  store.finalizeUserDownload(targetUserId);

  return {
    downloadedCount,
    processedChannels,
    totalChannels: channels.length,
  };
}
