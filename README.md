# Riyad Discord Bot

This bot now runs on JavaScript with `discord.js` and stores all state in a single local SQLite database instead of scattered text files.

## Project layout

```text
src/
  commands/        Slash command definitions and handlers
  events/          Discord event handlers
  services/        SQLite store and legacy import logic
  config.js        Runtime configuration
  bootstrap.js     Loads .env and starts the app
  index.js         App entrypoint
deploy/
  riyad-discord-bot.service.example
data/
  bot.sqlite       Created automatically at runtime
```

## Setup

1. Install Node 18 or newer on the server.
2. Copy `.env.example` to `.env`.
3. Fill in `DISCORD_TOKEN`.
4. Optionally set `DISCORD_GUILD_ID` if you want command updates to register instantly in one server.
5. Install dependencies:

```bash
npm install
```

6. Start the bot:

```bash
npm start
```

The app loads environment variables from `.env` itself, so it does not require `node --env-file` support from the system Node binary.

If `node -v` on the server is below 18, upgrade Node first before running `npm install`.

## Commands

- `/download <user> [message_count]` downloads a user's messages from the current guild into SQLite.
- `/delete <user>` removes a tracked user's stored messages and disables tracking.
- `/nerd <user>` enables auto-reacting with the nerd emoji.
- `/un-nerd <user>` disables auto-reacting with the nerd emoji.
- `/say <message> [message_id]` makes the bot send or reply with a message.
- `/nerd-list` lists nerded users.
- `/downloaded-list` lists tracked users.
