# Riyad Discord Bot

This bot now runs on JavaScript with `discord.js` and stores all state in a single local SQLite database instead of scattered text files.

## Project layout

```text
src/
  commands/        Slash command definitions and handlers
  events/          Discord event handlers
  services/        SQLite store and download logic
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
- `/download-status [user]` shows active download jobs, or the specific status for one user.
- `/download-cancel <user>` cancels an active download for a user.
- `/download-refresh-all [message_count]` refreshes every tracked user sequentially.
- `/help` privately lists every registered command and its description.
- `/backup` privately sends an atomic SQLite snapshot to an admin.
- `/reaction-chance [denominator]` shows or updates the special-role reaction mirror chance (1 in N).
- `/delete <user>` removes a tracked user's stored messages and disables tracking.
- `/tracked-user <user>` shows stored count, tracked state, nerd state, and reply mode for a user.
- `/nerd <user>` enables auto-reacting with the nerd emoji.
- `/un-nerd <user>` disables auto-reacting with the nerd emoji.
- `/reply-chance [percent]` shows or updates Riyad's random reply chance for tracked users.
- `/reply-mode <user> [percent]` shows or updates the per-user reply chance override.
- `/export-user <user>` exports a user's stored messages to a text attachment.
- `/random-line <user>` shows a random stored line for a user.
- `/stats` posts a richer public stats card with uptime, ping, memory, counts, and voice connection info.
- `/test-reply <user> [mentioned] [replying] [roll]` simulates whether Riyad would auto-reply.
- `/next-reply <message> [user_id]` queues the next custom auto-reply, globally or for one specific user.
- `/join <voice_channel> [persistence]` joins a voice channel by exact ID or name. `persistence` defaults to true and makes Riyad rejoin if disconnected from that channel.
- `/leave` leaves the voice channel Riyad is currently in and clears persistence for that guild.
- `/say <message> [message_id]` makes the bot send or reply with a message.
- `/nerd-list` lists nerded users.
- `/downloaded-list` lists tracked users.
- `/trivia` starts a ten-minute trivia round; `/scoreboard` lists winners.

## Optional web dashboard

Set `WEB_DASHBOARD_ENABLED=true` and a long, random `WEB_DASHBOARD_TOKEN` in `.env`, then restart.
The dashboard listens on `127.0.0.1:8787` by default (`WEB_DASHBOARD_HOST`/`WEB_DASHBOARD_PORT` to change).
Open it locally, enter the token, and manage tracked/nerded users, per-user and global reply chance,
reaction chance, always-reply user ID and nerd emoji. It also shows active downloads,
the next-reply queue and a guild's trivia scores (use Refresh status for current data),
and downloads a consistent SQLite backup.
The token is kept in browser memory only; neither it nor `DISCORD_TOKEN` is returned by an API.
Changes to the always-reply ID and emoji persist as SQLite overrides; Reset restores the `.env` default.
Global reply chance already persists in SQLite and takes precedence over `DEFAULT_REPLY_CHANCE_PERCENT`
after its first initialization. Do not expose the dashboard directly on a public network:
HTTP is unencrypted; use a private tunnel or authenticated HTTPS reverse proxy for remote access.
