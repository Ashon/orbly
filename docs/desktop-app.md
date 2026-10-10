# Desktop app

The desktop app (`apps/desktop`, Electron) starts and manages the bot (Socket Mode) as a child process and shows its status, logs and run history.
The UI is `apps/web` (React).

```sh
pnpm desktop        # build the bot, the UI and the app, then run it from the repository (development)
pnpm desktop:dev    # the UI runs on the Vite dev server (127.0.0.1:5179) and the app opens that address
pnpm package:mac    # build the installable Pacenote.app as a release zip in release/
pnpm install:mac    # unpack that zip into /Applications (quit Pacenote first)
```

Runs from the repository (`pnpm desktop`, `pnpm desktop:dev`) are named "Pacenote Dev": they have their own Electron user data
folder and single-instance lock, so they start next to an installed Pacenote. The top bar, the Dock icon (a DEV tag, drawn by
`icon.swift` as `assets/pacenote-icon-dev.png`) and the menu bar item say "Dev". Both use the
same config and data folder (`~/.pacenote`), so the bot lock still keeps a single bot running.

Packaging:

- `pnpm package:mac` builds `release/Pacenote-v<version>-macos-<arch>.app.zip` with a `.sha256` file. The arch defaults to
  this Mac's; `pnpm package:mac --arch x64` builds the Intel app. The app is assembled in `release/staging.noindex` and
  removed once zipped, so Spotlight and Launchpad list only the installed Pacenote.
- The app is ad-hoc signed, for this Mac only. Release builds are signed and notarized from these zips outside this
  repository, which also publishes them and updates the Homebrew cask. See `deploy/homebrew/README.md` for the steps a
  release takes here (versions, notes, tag).
- `pnpm install:mac` checks the zip for this Mac's arch against its `.sha256` and unpacks it into `/Applications`. It refuses to
  replace a running Pacenote, or a Pacenote installed with Homebrew (`brew uninstall --cask pacenote` first).

Using the packaged app:

- `Pacenote.app` contains the UI, the bot and sandbox job bundles (`pnpm bundle`) and the `sandbox/` files, so it runs without the repository, Node or pnpm.
  It needs Docker (sandbox), a reasoner CLI login (claude or codex), and gh and git for the ops tools.
- Config (`~/.pacenote/.env`), history and the allowed domains list live outside the app (`PACENOTE_HOME`, default `~/.pacenote`), so they are kept when the app is reinstalled.
- Sandbox apply jobs (image builds, proxy, broker, kubeconfig) run the job bundle inside the app with the app's Node.
  From the repository, the same jobs run with `pnpm sandbox:build`, `sandbox:up`, `sandbox:ops-up` and `k8s:kubeconfig`.
- The packaged app uses its bundles as they are, so it has no "Rebuild and restart". After changing code, reinstall with `pnpm package:mac && pnpm install:mac`.
- To avoid two bots on the same Slack app token, do not run `pnpm desktop` or `pnpm dev` while using the packaged app.
  (If both run, the bot run lock makes the one started later only show "Pace is running elsewhere, such as a terminal.")

Layout:

- The left rail switches sections: "Overview" (with the run list), "Pace" (the bot), and "Settings" at the bottom. The top bar holds the
  run search (Cmd+K focuses it, Esc clears it); the run list shows next to the overview and run details, while the bot and
  settings screens use the full width.
- The toggle at the left of the top bar (Cmd+B) hides or shows the run list, and the choice is remembered. When the window
  is too narrow for the list and the content side by side (under about 800 pixels), the list opens over the content
  instead: the toggle, Cmd+B or typing a search opens it, and picking a run, Esc or a click outside closes it.
- The window can be as narrow as 600 pixels. Narrow screens stack their cards and rows, and Settings shows its sections as
  icons.
- The status bar at the bottom holds status to glance at: bot connection status, reasoner backend, attached tools, startup check issues (when any),
  requests in progress, and last request time. Clicking the "Pace: ..." status item opens the Pace screen.

Bot management:

- Opening the app starts the bot automatically. (Turn it off with "Start the bot when the app opens" under Settings > General. It is stored in `PACENOTE_DATA_DIR/desktop.json`)
- The bot runs as an Electron utilityProcess. Development runs use the repository's `dist/index.js` and run `pnpm build` first when `src` is newer.
  The packaged app uses its bundled bot (`bot/index.mjs`) as is.
  Environment variables are read from the config file (`~/.pacenote/.env`) like `node --env-file`, and existing environment variables take precedence.
  PATH comes from the login shell. (So docker, codex and pnpm are found even when the app is launched from Finder)
- The Pace screen has "Start", "Stop", "Restart" and "Rebuild and restart" (development runs only). The number of requests in progress is shown next to the menu bar icon.
- The menu bar (tray) holds only "Open Pacenote" at the top, then the bot status ("Pace: ...") with "Start Pace" (when stopped) or "Restart Pace", and "Quit Pacenote".
  App settings (automatic start, run history folder) are in Settings.
- Stop and app quit send SIGTERM. The bot waits up to 20 seconds for requests in progress, and the rest resume on the next start.
- Before launching the bot, the app checks the settings with the bot's own rules. When the Slack tokens are missing (a first run) or a
  value is invalid, it does not launch the bot and shows "Setup needed" with a way to Settings (on the Pace screen, the Overview,
  the status bar, and the tray menu). That way opens the section to fix: Slack for missing or rejected tokens, otherwise the section
  of the first invalid value. Tokens Slack rejects (`invalid_auth` and the like) also end up there. Saving in Settings then starts
  the bot ("Save and start Pace").
- If the bot dies after running normally for 30 seconds or more, it shows "Crashed" and is restarted after 3 seconds (up to 3 times in
  10 minutes). If it stops right after starting for another reason, or a dev build fails, it shows "Failed to start" with the cause and
  the last output on the Pace screen.
- If a bot is already running from a terminal (`pnpm dev` and so on), the app leaves it alone and only shows its status and logs as "Running in terminal".
  When the terminal bot stops, the app takes over. (It starts the bot right away if automatic start is on)
- Closing the window hides the app in the tray and the bot keeps running. Quit from the tray menu or with Cmd+Q.
- With `PACENOTE_DESKTOP_BOT=off`, the app does not manage the bot and only shows history.

Settings:

- The gear icon at the bottom of the left rail ("Settings") edits the config file (`~/.pacenote/.env`). The app and terminal runs use the same file, so settings do not diverge.
- Settings has its own section list (`#/settings/<section>`): General for the app first, then the bot's sections.

  | Section | What it holds |
  | --- | --- |
  | General | Theme, starting the bot with the app, the settings file and run history folder |
  | Messengers | Each chat app under its own heading with how it is connected. Slack: the connection (team hub with pairing, or your own app's tokens) with "Check connection", allowed users, Socket Mode keepalive (advanced) |
  | Answers | Reasoner CLI, model, timeout, concurrent requests, time zone, reference directory, diagrams and images |
  | Sandbox | Run environment (on this Mac or the docker sandbox), limits, the reasoner login, allowed domains, status and apply jobs |
  | Ops tools | The on/off switch with what it needs, then one card per integration: files, GitHub and pull requests, Jira, Kubernetes, SSH hosts |
  | History & logs | Run history and retention, log level |

- The section list shows what needs attention: "Not connected" when Slack tokens are missing, "Apply needed" for changes the sandbox or
  broker has not picked up, "Off" for an unused sandbox or ops tools, and per section the number of unsaved changes or a red dot for
  values to fix. Changes in several sections are saved together from the bar at the bottom, which also names the section with a problem.
- Fields show only when they apply: sandbox limits only for the docker sandbox, and only the selected reasoner's login (claude token or
  codex login file). Hidden values stay in `.env`. Each ops integration card says whether its fields turn it on ("On", "Incomplete", "Off")
  and what the running broker reports. Rarely changed values are collapsed under "Advanced".
  Fields, groups and sections are defined only in `src/settings/fields.ts`, and a test checks that their defaults match the bot config (`src/config.ts`).
- Secret values such as tokens are never sent to the UI. Only the prefix and the last 4 characters are shown; enter a new value to change one.
  The Save button next to the input (or Enter) saves just that value and closes the input; Esc cancels.
- "Check connection" checks the bot token, the bot scopes, that both tokens belong to the same app, and Socket Mode, with the entered tokens (or the current ones).
  (The same checks as `pnpm slack:check`; it only fetches the connection URL and does not connect)
- Before saving, values are validated with the same rules as the bot. Problems are shown next to the field and nothing is saved.
  A value that is only missing (a Slack token, the hub pairing, the sandbox's claude token) does not block saving the rest, so a setup
  can be saved a piece at a time; the bot shows "Setup needed" until it is complete.
- Saving keeps comments, order, and entries the settings screen does not handle (such as personal API keys). Fields reset to their default are emptied as `KEY=`.
  New entries are appended at the end, and the file mode (600) is kept.
- Saved settings take effect after the bot restarts. "Save and restart Pace" does both at once.
- A field also set in the app's environment variables takes precedence over `.env`, so the UI marks it.
- Socket Mode keepalive values: `SOCKET_CLIENT_PING_TIMEOUT_MS` (default 5000), `SOCKET_SERVER_PING_TIMEOUT_MS` (default 30000),
  `SOCKET_PING_PONG_LOG` (default off, visible with `LOG_LEVEL=debug`)
- `SLACK_API_URL` (not on the screen): your own app's Slack Web API, default `https://slack.com/api/`; `https://slack-gov.com/api/`
  for GovSlack. http is accepted only for this computer, which is how the end-to-end tests point the bot at a fake Slack.
- Settings are read and written only over the app's internal IPC, like bot control. The query API and the browser dev server cannot change settings.

Sandbox (the "Sandbox" and "Ops tools" sections of Settings):

- The sandbox has three components, and each applies settings differently. Each section says how its settings apply.

  | Component | Settings | Applied by |
  | --- | --- | --- |
  | Reasoner sandbox (a new container per request) | `SANDBOX_*`, `OPS_TOOLS` | Restarting the bot |
  | Allowed outbound domains (egress-proxy) | `~/.pacenote/sandbox/allowed-domains.txt` | Restarting the proxy (`pnpm sandbox:up`) |
  | ops-broker | `OPS_GIT_*`, `OPS_FS_ROOT`, `OPS_SSH_*`, `OPS_K8S_*`, `OPS_JIRA_*` | Recreating the broker (`pnpm sandbox:ops-up`) |

- Status: docker, the 4 images, the proxy and broker containers, broker tools (SSH host count, k8s, files, GitHub, PR, Jira), credential files,
  gh login and git author. Credential values are not read; only their presence is checked.
- Pending changes: components whose changed settings are not applied yet are listed with the reason (for example "Restart proxy needed")
  and can be applied in place.
  - Bot: when the config fingerprint (`configHash`) the bot wrote to its status file at startup differs from the one computed from the current `.env`
  - Proxy: when the allowlist changed after the proxy started, or when the proxy is not running
  - Broker: when the container settings (SSH user, allowed range, GitHub orgs, mount paths) differ from `.env`, when a newer image exists or
    the `src/broker` code is newer than the image, or when the host list or kubeconfig changed after the broker started
- Allowed domains accept exact host names only (wildcards, IPs, ports and URLs are rejected). Domains the current reasoner CLI needs cannot be removed.
  Internal systems that need a token are connected as broker tools instead of opening their domains.
- Apply jobs: "Build sandbox images" (`sandbox:build`), "Rebuild kubeconfig" (`k8s:kubeconfig`), "Restart proxy" and "Recreate broker"
  run from the app and show their output. Only one runs at a time, and secret values in the output are masked.
  Restarting the proxy or the broker cuts off tool calls in progress, so these jobs are blocked while requests are in progress.
- Paths the broker mounts (`OPS_FS_ROOT`, `OPS_SSH_KEY`, `OPS_SSH_KNOWN_HOSTS`) must be absolute. (compose does not expand `~`)

Status and logs:

- The bot writes its status (Socket Mode connection state and reconnect count, bot account, reasoner backend, requests in progress and handled,
  sandbox check problems) to `PACENOTE_DATA_DIR/bot.json`. The app reads it the same way no matter who started the bot.
- Logs go to the console and to `PACENOTE_DATA_DIR/logs/bot.log`. (Past 5MB it rolls over to `bot.log.1`)
  Bolt and Socket Mode client logs go through the same logger, with the scopes `pacenote:socket` and `pacenote:bolt`.
  Connects, reconnects, disconnects and received events (envelope, retry count) are logged.
- The log file masks token and key formats and the ticket in the Socket Mode connection URL.
- The Pace screen shows logs as "All", "Socket Mode", "Mentions" or "Warnings and errors", with search. It rereads them every 2 seconds and follows the end.
  With `LOG_LEVEL=debug`, detailed Socket Mode client logs are also written.

Run history:

```
~/.pacenote/runs/<YYYY-MM-DD>/<run id>/run.json      # request, context count, attachments, prompt, steps, answer, status
~/.pacenote/runs/<YYYY-MM-DD>/<run id>/artifacts/    # images passed to the model, generated images and diagrams posted
```

- The bot records a run for every mention it handles. (`HISTORY=on`, the default)
- Steps are extracted from the CLI's JSON output (codex `--json`, claude `stream-json`): messages, thinking, tool calls (arguments, results,
  duration), shell commands and token usage. Tool results are stored up to 8,000 characters.
- Statuses are "Running", "Succeeded", "Failed" and "Interrupted". A request resumed after a restart continues in the same record
  ("Resumed after a bot restart (attempt 2)"), and records that will not be resumed are marked "Interrupted" at startup.
- Date directories older than `HISTORY_RETENTION_DAYS` (default 30 days) are deleted. Change the location with `PACENOTE_DATA_DIR`.
- Records contain thread context and attachment contents, so they stay local.
- UI: run list (status filter, search), "Overview" (last 14 days, success rate, average duration, top tools), run detail ("Timeline" of the work
  in the order request -> tool calls -> answer -> outputs, "Attachments", "Prompt", raw "JSON"). Runs in progress are reread every 1.5 seconds.

Other:

- The query API is served only inside the app at `pacenote://app/api/*`, with no open port. Bot control uses preload IPC only.
  The dev server (`apps/web` Vite) listens only on 127.0.0.1 and attaches the same query API read-only.
- The data location is taken from the `PACENOTE_DATA_DIR` environment variable, then `PACENOTE_DATA_DIR` in the config file, then the
  default home (`~/.pacenote`, or `~/.orbly` or `~/.verda` while `~/.pacenote` does not exist; see [Migrating from Orbly or Verda](migrating.md)).
- App icon: `assets/pacenote-icon.svg` is the source. After editing it, `pnpm --filter @pacenote/desktop icon` (macOS swift) redraws
  the same shape on the macOS icon grid (an 824 body in 1024, shadow, highlight) as `assets/pacenote-icon.png`.
  Development runs use the PNG as the Dock icon as is, so this does the system's processing by hand.
- `PACENOTE_DESKTOP_THEME=light|dark` pins the theme. (The default follows the system; it can also be changed under "Theme" in Settings > General)
- Build check: `PACENOTE_DESKTOP_CAPTURE=/tmp/pacenote.png pnpm --filter @pacenote/desktop start` saves the UI as a PNG without showing
  a window, then exits. (`PACENOTE_DESKTOP_CAPTURE_HASH=#/bot` picks the screen, and `PACENOTE_DESKTOP_CAPTURE_WIDTH` and
  `PACENOTE_DESKTOP_CAPTURE_HEIGHT` the window size; the bot is not started in this mode)
