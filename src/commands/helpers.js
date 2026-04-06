export async function requireAdmin(interaction, config) {
  if (interaction.user.id === config.specialUserId) {
    return true;
  }

  const response = {
    content: 'You do not have permission to use this command.',
    ephemeral: true,
  };

  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(response);
  } else {
    await interaction.reply(response);
  }

  return false;
}

export function mentionList(userIds, emptyMessage, title) {
  if (!userIds.length) {
    return emptyMessage;
  }

  return `**${title}:**\n${userIds.map((userId) => `<@${userId}>`).join('\n')}`;
}

export function formatDateTime(value) {
  if (!value) {
    return 'Never';
  }

  return new Date(value).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function formatReplyMode(summary) {
  return summary.replyChanceOverride === null
    ? `Inheriting global chance (${summary.effectiveReplyChancePercent}%)`
    : `${summary.replyChanceOverride}% override`;
}

export function formatTrackedUserSummary(summary, config) {
  return [
    `**Tracked user: <@${summary.userId}>**`,
    `Tracked: ${summary.tracked ? 'Yes' : 'No'}`,
    `Nerded: ${summary.nerded ? 'Yes' : 'No'}`,
    `Stored messages: ${summary.messageCount}`,
    `Reply mode: ${formatReplyMode(summary)}`,
    `Last download: ${formatDateTime(summary.lastDownloadedAt)}`,
    `Last updated: ${formatDateTime(summary.updatedAt)}`,
    summary.userId === config.alwaysReplyUserId
      ? 'Special rule: always replies when this user mentions or replies to Riyad.'
      : null,
  ].filter(Boolean).join('\n');
}

export function formatDownloadJobSummary(job) {
  if (!job) {
    return 'No active download job.';
  }

  const goal = job.limit === null
    ? (job.totalResults ?? 'unknown')
    : (job.totalResults === null ? job.limit : Math.min(job.limit, job.totalResults));

  return [
    `Status: ${job.status}`,
    `Progress: ${job.downloadedCount}/${goal} messages`,
    `Search requests: ${job.requestsMade}`,
    `Last page added: ${job.lastPageCount}`,
    job.status === 'indexing' ? `Retry after: ${job.retryAfterSeconds}s` : null,
  ].filter(Boolean).join('\n');
}
