import { entersState, getVoiceConnection, joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import { ChannelType } from 'discord.js';

export class VoiceManager {
  constructor(client) {
    this.client = client;
    this.persistentTargets = new Map();
  }

  getConnection(guildId) {
    return getVoiceConnection(guildId);
  }

  getCurrentChannelId(guildId) {
    return this.getConnection(guildId)?.joinConfig.channelId ?? null;
  }

  async resolveVoiceChannel(guild, query) {
    const trimmedQuery = query.trim();

    const directMatch = guild.channels.cache.get(trimmedQuery)
      ?? await guild.channels.fetch(trimmedQuery).catch(() => null);

    if (isVoiceChannel(directMatch)) {
      return { channel: directMatch, ambiguous: false };
    }

    const voiceChannels = [...guild.channels.cache.values()].filter(isVoiceChannel);
    const exactNameMatches = voiceChannels.filter((channel) => channel.name.toLowerCase() === trimmedQuery.toLowerCase());

    if (exactNameMatches.length === 1) {
      return { channel: exactNameMatches[0], ambiguous: false };
    }

    if (exactNameMatches.length > 1) {
      return { channel: null, ambiguous: true, matches: exactNameMatches };
    }

    const partialMatches = voiceChannels.filter((channel) => channel.name.toLowerCase().includes(trimmedQuery.toLowerCase()));

    if (partialMatches.length === 1) {
      return { channel: partialMatches[0], ambiguous: false };
    }

    if (partialMatches.length > 1) {
      return { channel: null, ambiguous: true, matches: partialMatches };
    }

    return { channel: null, ambiguous: false, matches: [] };
  }

  async join(channel, { persistence = true } = {}) {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

    if (persistence) {
      this.persistentTargets.set(channel.guild.id, channel.id);
    } else {
      this.persistentTargets.delete(channel.guild.id);
    }

    return connection;
  }

  leave(guildId) {
    this.persistentTargets.delete(guildId);
    const connection = this.getConnection(guildId);

    if (connection) {
      connection.destroy();
    }

    return connection ?? null;
  }

  isPersistent(guildId) {
    return this.persistentTargets.has(guildId);
  }

  async handleVoiceStateUpdate(oldState, newState) {
    const botUserId = this.client.user?.id;

    if (!botUserId || oldState.id !== botUserId) {
      return;
    }

    const persistentChannelId = this.persistentTargets.get(oldState.guild.id);

    if (!persistentChannelId) {
      return;
    }

    if (oldState.channelId !== persistentChannelId || newState.channelId !== null) {
      return;
    }

    const channel = oldState.guild.channels.cache.get(persistentChannelId)
      ?? await oldState.guild.channels.fetch(persistentChannelId).catch(() => null);

    if (!isVoiceChannel(channel)) {
      this.persistentTargets.delete(oldState.guild.id);
      return;
    }

    setTimeout(async () => {
      try {
        await this.join(channel, { persistence: true });
      } catch (error) {
        console.error(`Failed to rejoin persistent voice channel ${channel.id}`, error);
      }
    }, 1500);
  }
}

function isVoiceChannel(channel) {
  return channel && (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice);
}
