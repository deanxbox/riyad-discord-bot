import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { handleInteractionCreate } from './events/interaction-create.js';
import { handleMessageCreate } from './events/message-create.js';
import { handleRaw } from './events/raw.js';
import { handleReady } from './events/ready.js';
import { DataStore } from './services/data-store.js';
import { DownloadJobManager } from './services/download-jobs.js';
import { NextReplyQueue } from './services/next-reply-queue.js';
import { VoiceManager } from './services/voice-manager.js';
import { startWebDashboard } from './web/server.js';
import { logError } from './services/errors.js';

const store = new DataStore(config.dbPath, {
  defaultReplyChancePercent: config.defaultReplyChancePercent,
  alwaysReplyUserId: config.alwaysReplyUserId,
  nerdEmoji: config.nerdEmoji,
  triviaTimeoutSeconds: config.triviaTimeoutSeconds,
  triviaBonusSeconds: config.triviaBonusSeconds,
});
config.alwaysReplyUserId = store.getAlwaysReplyUserId();
config.nerdEmoji = store.getNerdEmoji();
for (const key of ['specialUserId', 'specialRoleId', 'guildId']) {
  config[key] = store.getDashboardSetting(key, config[key]);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

const downloadJobs = new DownloadJobManager({ client, config, store });
const nextReplyQueue = new NextReplyQueue();
const voiceManager = new VoiceManager(client);
const context = { client, config, store, downloadJobs, nextReplyQueue, voiceManager };
const webDashboard = config.webDashboardEnabled
  ? startWebDashboard({ config, store, downloadJobs, nextReplyQueue, client })
  : null;

client.once(Events.ClientReady, async () => {
  await handleReady(client, config).catch(error => logError('Discord ready handler failed', error));
});

client.on(Events.InteractionCreate, async (interaction) => {
  await handleInteractionCreate(interaction, context).catch(error => logError(`Discord interaction ${interaction.id} failed`, error));
});

client.on(Events.MessageCreate, async (message) => {
  await handleMessageCreate(message, context).catch(error => logError(`Discord message ${message.id} failed`, error));
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  await voiceManager.handleVoiceStateUpdate(oldState, newState).catch(error => logError(`Discord voice state ${oldState.guild.id} failed`, error));
});

client.on(Events.Raw, async (packet) => {
  await handleRaw(packet, context).catch(error => logError(`Discord raw event ${packet.t} failed`, error));
});

client.on(Events.Error, (error) => {
  console.error('Discord client error', error);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    webDashboard?.close();
    store.close();
    client.destroy();
    process.exit(0);
  });
}

await client.login(config.token);

// Older downloads stored no server ID; resolve it from each message's channel.
for (const channelId of store.listUnassignedChannelIds()) {
  const channel = client.channels.cache.get(channelId) ?? await client.channels.fetch(channelId).catch(() => null);
  if (channel?.guildId) store.assignGuildToChannel(channelId, channel.guildId);
}
downloadJobs.resumeSavedJobs();
