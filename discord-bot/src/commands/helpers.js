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
