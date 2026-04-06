import { commandPayload } from '../commands/index.js';

export async function handleReady(client, config) {
  console.log(`Logged in as ${client.user.tag}`);

  if (config.guildId) {
    const guild = await client.guilds.fetch(config.guildId);
    await guild.commands.set(commandPayload);
    console.log(`Synced ${commandPayload.length} guild commands to ${config.guildId}`);
    return;
  }

  await client.application.commands.set(commandPayload);
  console.log(`Synced ${commandPayload.length} global commands`);
}
