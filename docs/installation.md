# Installation

There are two ways to run Pacenote: the desktop app from Homebrew, or from source with pnpm. Both need the
Slack app from steps 1-3 under "From source".

## Install with Homebrew

The desktop app installs from the Homebrew tap (macOS 12 or later, Apple silicon or Intel):

```sh
brew tap ashon/tap
brew install --cask pacenote
```

- The app carries the bot, the sandbox jobs and its own Node, so it needs no repository, Node or pnpm. It needs Docker
  (Docker Desktop, OrbStack or colima) for the sandbox, a `claude` or `codex` CLI login, and `gh` and `git` for the ops tools.
- After creating the Slack app, open Pacenote, enter the Slack tokens in Settings > Messengers > Slack, then run "Build sandbox images"
  and "Restart proxy" in Settings > Sandbox.
- Config, run history and the allowed domains list live in `~/.pacenote` (`PACENOTE_HOME`), outside the app, so they survive
  upgrades and uninstall.
- `brew upgrade --cask pacenote` quits the running app first (the bot gets up to 20 seconds to finish its requests, and the rest
  resume on the next start) and reopens it. `brew uninstall --cask pacenote` removes the app and keeps `~/.pacenote`.

## From source

1. Slack app: https://api.slack.com/apps -> Create New App -> From an app manifest ->
   paste `slack-app-manifest.yaml`. For an existing app, only match the scopes and events below.
   - Bot Token Scopes: `app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `files:read`, `files:write`, `users:read`
   - Event Subscriptions > bot events: `app_mention`
   - Turn on Socket Mode
2. Basic Information -> App-Level Tokens: create a token with `connections:write` -> `SLACK_APP_TOKEN`
3. Invite the bot to the public channels where it should answer. (`/invite @botname`)
4. Write the config file and check it. Config lives outside the repository in `~/.pacenote/.env`. (`PACENOTE_HOME` changes the location)
   The bot (app, terminal), the setup commands and the sandbox compose all read this file, so values of the target environment never land in the repository.

   ```sh
   mkdir -p ~/.pacenote && cp .env.example ~/.pacenote/.env   # fill in SLACK_*, REASONER, REASONER_SANDBOX
   pnpm install
   pnpm slack:check        # check tokens, scopes, app match, Socket Mode
   ```

5. Run

   ```sh
   pnpm desktop             # the desktop app starts and manages the bot (recommended, see desktop-app.md)
   pnpm dev                 # development in a terminal (watch)
   pnpm build && pnpm start # run in a terminal
   ```

Two processes with the same app token make Slack split events between them, so run only one.
At startup the bot takes a run lock through `PACENOTE_DATA_DIR/bot.json`. If another bot is alive, it waits 30 seconds for it to exit,
and if it is still alive it exits with "Pacey is already running".
`pnpm dev` restarts the process whenever the source changes, so requests in progress can be cut off while you edit code.

Restart handling:

- Mentions in progress are recorded in `PACENOTE_DATA_DIR/inflight.json`. After a restart the bot resumes each one once in the same placeholder
  message ("I restarted, so I'm picking this up again..."). Requests already resumed once or older than 30 minutes are replaced with
  "I couldn't finish this: I restarted and the request was cut off. Please mention me again."
- On a shutdown signal (SIGINT, SIGTERM) it stops taking new events and waits up to 20 seconds for requests in progress.
- At startup it deletes attachment/output temp directories (`PACENOTE_DATA_DIR/attachments/*`) older than 1 hour.

Requirements: Node.js 22.9 or later, pnpm 11, and Docker for the sandbox.
