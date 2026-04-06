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

1. Install Node 22 or newer on the server.
2. Copy `.env.example` to `.env`.
3. Fill in `DISCORD_TOKEN`.
4. Optionally set `DISCORD_GUILD_ID` if you want command updates to register instantly in one server.
5. Optionally tune `DEFAULT_REPLY_CHANCE_PERCENT` and `ALWAYS_REPLY_USER_ID` in `.env`.
6. Install dependencies:

```bash
npm install
```

7. Start the bot:

```bash
npm start
```

The app loads environment variables from `.env` itself, so it does not require `node --env-file` support from the system Node binary.

This version uses Node's built-in SQLite module, so there is no native SQLite addon to compile during deploy.

If `node -v` on the server is below 22, upgrade Node first before running `npm install`.

## Commands

- `/download <user> [message_count]` starts a cancellable download job that uses Discord's guild search API to fetch that user's messages directly. The progress reply is ephemeral, so only the person who ran the command can see it.
- `/delete <user>` removes a tracked user's stored messages and disables tracking.
- `/nerd <user>` enables auto-reacting with the nerd emoji.
- `/un-nerd <user>` disables auto-reacting with the nerd emoji.
- `/reply-chance [percent]` shows or updates Riyad's random reply chance for tracked users.
- `/say <message> [message_id]` makes the bot send or reply with a message.
- `/nerd-list` lists nerded users.
- `/downloaded-list` lists tracked users.
