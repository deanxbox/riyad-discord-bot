import { GatewayRateLimitError } from 'discord.js';

const inFlight = new Map();

export async function getGuildMembers(guild) {
  if (inFlight.has(guild.id)) return inFlight.get(guild.id);
  if (guild.members.cache.size >= guild.memberCount) return guild.members.cache;

  const fetch = guild.members.fetch()
    .catch(error => {
      if (!(error instanceof GatewayRateLimitError)) throw error;
    })
    .then(() => guild.members.cache)
    .finally(() => inFlight.delete(guild.id));
  inFlight.set(guild.id, fetch);
  return fetch;
}
