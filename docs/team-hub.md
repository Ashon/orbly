# Team hub

For several people in one workspace: one hub server holds the Slack app, and each member's Pacenote desktop answers that
member's mentions with their own `claude` or `codex` login, sandbox and ops tools.

```
Slack <--Socket Mode--> hub (deploy/hub: Slack tokens, paired desktops) <--WebSocket over HTTPS--> each member's Pacenote
```

- The Slack tokens live only on the hub. Desktops never get one: their Slack Web API calls, file downloads and uploads go
  through the hub (`/api/*`, `/files`, `/upload`), which makes them with the bot token.
- The hub allows a desktop only what the thread routed to it needs (`src/hub/policy.ts`): read that thread (and the few
  messages before a mention outside a thread), post in it, edit what it posted, read its files, and upload into it, for
  2 hours after the mention. Other calls are refused with errors like `thread_not_granted` or `method_not_allowed_by_hub`.
- Routing: a mention goes to the desktop of the member who wrote it. Members without a paired desktop, or whose desktop is
  offline, get a message only they can see that says so.
- Pairing: in Pacenote, Settings > Messengers > Slack > Team hub, enter the hub URL and choose Connect. Pacenote shows a code; send
  `@Pace connect <code>` in a channel Pacenote is in, then confirm in Pacenote that the Slack account shown is yours.
  The confirmation is what counts, so a code someone else saw and sent first is turned down on the desktop.
  The desktop keeps a random token in `.env` (`HUB_TOKEN`); the hub stores only its SHA-256.
- One desktop per member: pairing again replaces the previous desktop. Settings > Messengers > Slack > Disconnect unpairs it.
- The hub sees mentions and thread content in transit (as Slack's own servers do) and stores only paired desktops.
  Grants are kept in memory, so restarting the hub ends edits to answers in progress.

Running the hub (on a server of its own, with Docker):

1. Create the Slack app from `slack-app-manifest.yaml` (Socket Mode), install it, and create an app-level token with
   `connections:write`.
2. On a machine with the repository: `pnpm install && pnpm bundle`, which writes `deploy/hub/dist/hub.mjs`
   (`pnpm hub:image` also builds the image `pacenote-hub:latest`).
3. In `deploy/hub`: `cp hub.env.example hub.env`, fill in `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN` and `HUB_PUBLIC_URL`
   (optionally `HUB_ALLOWED_USERS`), then `docker compose up -d --build`. Paired desktops are kept in the `hub-data` volume.
4. The hub listens on `127.0.0.1:8790`. Serve it over HTTPS at `HUB_PUBLIC_URL`, for example with Caddy:
   `pacenote-hub.example.com { reverse_proxy 127.0.0.1:8790 }` (WebSockets pass through). Desktops accept only https URLs
   (http only for localhost).
5. Give members the URL. `docker compose logs -f hub` shows pairings, connections, routed mentions and refused calls.

| Hub setting (`hub.env`) | Meaning |
| --- | --- |
| `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN` | The Slack app's tokens (required) |
| `HUB_PUBLIC_URL` | The HTTPS URL members use; upload URLs handed to desktops are built from it |
| `HUB_ALLOWED_USERS` | Comma-separated Slack user IDs who may pair and use the hub. Empty: everyone |
| `HUB_PORT`, `HUB_HOST`, `HUB_DATA_DIR` | Listen port (8790, 0 for any free one), address (0.0.0.0) and data folder (`/data`) |
| `SLACK_API_URL` | Slack's Web API (default `https://slack.com/api/`): `https://slack-gov.com/api/` for GovSlack. The hub fetches files only from that Slack's file host |
| `LOG_LEVEL` | debug, info (default), warn, error |
