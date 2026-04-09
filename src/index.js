import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { handleInteractionCreate } from './events/interaction-create.js';
import { handleMessageCreate } from './events/message-create.js';
import { handleRaw } from './events/raw.js';
import { handleReady } from './events/ready.js';
import { DataStore } from './services/data-store.js';
import { DownloadJobManager } from './services/download-jobs.js';
import { importLegacyStoreIfPresent } from './services/legacy-import.js';
import { NextReplyQueue } from './services/next-reply-queue.js';
import { VoiceManager } from './services/voice-manager.js';

const store = new DataStore(config.dbPath, {
  defaultReplyChancePercent: config.defaultReplyChancePercent,
});
const legacyImportResult = importLegacyStoreIfPresent(store, config.rootDir);

if (legacyImportResult.imported) {
  console.log('Imported legacy text-file data into SQLite.');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});

const downloadJobs = new DownloadJobManager({ client, config, store });
const nextReplyQueue = new NextReplyQueue();
const voiceManager = new VoiceManager(client);
const context = { client, config, store, downloadJobs, nextReplyQueue, voiceManager };

client.once(Events.ClientReady, async () => {
  await handleReady(client, config);
});

client.on(Events.InteractionCreate, async (interaction) => {
  await handleInteractionCreate(interaction, context);
});

client.on(Events.MessageCreate, async (message) => {
  await handleMessageCreate(message, context);
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  await voiceManager.handleVoiceStateUpdate(oldState, newState);
});

client.on(Events.Raw, async (packet) => {
  await handleRaw(packet, context);
});

client.on(Events.Error, (error) => {
  console.error('Discord client error', error);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    store.close();
    client.destroy();
    process.exit(0);
  });
}

await client.login(config.token);
