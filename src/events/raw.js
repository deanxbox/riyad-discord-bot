function isNerdEmoji(emoji, config) {
  return emoji?.name === config.nerdEmoji;
}

function reactionIdentifier(emoji) {
  return emoji?.id || emoji?.name;
}

async function fetchMessageFromPacket(client, packet) {
  const channel = await client.channels.fetch(packet.d.channel_id).catch(() => null);

  if (!channel || !channel.isTextBased() || typeof channel.messages?.fetch !== 'function') {
    return null;
  }

  return channel.messages.fetch(packet.d.message_id).catch(() => null);
}

export async function handleRaw(packet, { client, config }) {
  if (!packet?.t || !packet?.d?.guild_id || packet.d.user_id === client.user.id) {
    return;
  }

  if (packet.t === 'MESSAGE_REACTION_ADD') {
    await handleReactionAdd(packet, { client, config });
    return;
  }

  if (packet.t === 'MESSAGE_REACTION_REMOVE') {
    await handleReactionRemove(packet, { client, config });
  }
}

async function handleReactionAdd(packet, { client, config }) {
  const userId = packet.d.user_id;

  if (userId === config.specialUserId && isNerdEmoji(packet.d.emoji, config)) {
    const message = await fetchMessageFromPacket(client, packet);
    const reaction = message?.reactions.resolve(reactionIdentifier(packet.d.emoji));

    if (reaction) {
      await reaction.users.remove(userId).catch((error) => {
        console.error(`Failed to remove nerd emoji reaction from ${userId}`, error);
      });
    }

    return;
  }

  const hasSpecialRole = packet.d.member?.roles?.includes(config.specialRoleId);
  const shouldMirrorReaction =
    userId === config.specialUserId ||
    (hasSpecialRole && Math.floor(Math.random() * config.reactionChanceDenominator) === 0);

  if (!shouldMirrorReaction) {
    return;
  }

  const message = await fetchMessageFromPacket(client, packet);

  if (!message) {
    return;
  }

  await message.react(reactionIdentifier(packet.d.emoji)).catch((error) => {
    console.error(`Failed to mirror reaction on message ${packet.d.message_id}`, error);
  });
}

async function handleReactionRemove(packet, { client, config }) {
  if (packet.d.user_id !== config.specialUserId) {
    return;
  }

  const message = await fetchMessageFromPacket(client, packet);
  const reaction = message?.reactions.resolve(reactionIdentifier(packet.d.emoji));

  if (reaction) {
    await reaction.users.remove(client.user.id).catch((error) => {
      console.error(`Failed to remove mirrored reaction from message ${packet.d.message_id}`, error);
    });
  }
}
