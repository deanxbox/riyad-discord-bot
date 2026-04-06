export function evaluateReplyDecision({
  userId,
  tracked,
  storedMessageCount,
  mentionedBot,
  repliedToBot,
  store,
  config,
  randomValue = Math.random() * 100,
}) {
  if (!tracked) {
    return {
      shouldReply: false,
      reason: 'User is not tracked.',
      effectiveReplyChancePercent: store.getEffectiveReplyChancePercent(userId),
      randomValue,
    };
  }

  if (storedMessageCount <= 0) {
    return {
      shouldReply: false,
      reason: 'No stored messages are available for replies.',
      effectiveReplyChancePercent: store.getEffectiveReplyChancePercent(userId),
      randomValue,
    };
  }

  if (userId === config.alwaysReplyUserId && (mentionedBot || repliedToBot)) {
    return {
      shouldReply: true,
      reason: 'Special user always gets a response when mentioning or replying to Riyad.',
      effectiveReplyChancePercent: 100,
      randomValue,
    };
  }

  const effectiveReplyChancePercent = store.getEffectiveReplyChancePercent(userId);

  if (effectiveReplyChancePercent <= 0) {
    return {
      shouldReply: false,
      reason: 'Reply chance is set to 0% for this user.',
      effectiveReplyChancePercent,
      randomValue,
    };
  }

  if (mentionedBot) {
    return {
      shouldReply: true,
      reason: 'Mentioning Riyad forces a reply.',
      effectiveReplyChancePercent: 100,
      randomValue,
    };
  }

  const shouldReply = randomValue < effectiveReplyChancePercent;

  return {
    shouldReply,
    reason: shouldReply
      ? 'Random reply check passed.'
      : 'Random reply check did not pass.',
    effectiveReplyChancePercent,
    randomValue,
  };
}
