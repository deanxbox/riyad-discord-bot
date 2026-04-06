function shouldReplyToTrackedMessage(message, { store, config }) {
  if (message.author.id === config.alwaysReplyUserId && (message.mentions.has(message.client.user) || isReplyToBot(message))) {
    return true;
  }

  if (message.mentions.has(message.client.user)) {
    return true;
  }

  return Math.random() * 100 < store.getReplyChancePercent();
}

function truncateReply(content) {
  return content.length > 2000 ? content.slice(0, 2000) : content;
}

function isReplyToBot(message) {
  return message.reference?.messageId && message.mentions.repliedUser?.id === message.client.user.id;
}

export async function handleMessageCreate(message, { store, config }) {
  if (!message.inGuild() || message.author.bot) {
    return;
  }

  const userId = message.author.id;
  const tracked = store.isTracked(userId);
  const nerded = store.isNerded(userId);

  if (!tracked && !nerded) {
    return;
  }

  if (tracked && message.content.trim().length > 0) {
    store.appendLiveMessage({
      messageId: message.id,
      userId,
      guildId: message.guildId,
      channelId: message.channelId,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    });
  }

  if (nerded) {
    try {
      const existingReaction = message.reactions.resolve(config.nerdEmoji);

      if (!existingReaction?.me) {
        await message.react(config.nerdEmoji);
      }
    } catch (error) {
      console.error(`Failed to react to message ${message.id}`, error);
    }
  }

  if (tracked && store.getMessageCount(userId) > 0 && shouldReplyToTrackedMessage(message, { store, config })) {
    const reply = store.getRandomMessage(userId);

    if (reply) {
      await message.reply({
        content: truncateReply(reply),
        allowedMentions: { repliedUser: false },
      }).catch((error) => {
        console.error(`Failed to reply to message ${message.id}`, error);
      });
    }
  }
}
