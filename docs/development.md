# Development

```sh
pnpm check          # typecheck (bot, UI, app) + lint + format:check + test
pnpm test
pnpm test:e2e       # end-to-end: the bot and the hub against a fake Slack and a fake claude (about 15 s)
pnpm test:e2e:coverage  # the same, with the bot's and the hub's coverage (coverage/e2e/index.html)
pnpm test:e2e:app   # end-to-end through the desktop app's window (builds first; opens a window)
```

## Code style

Prettier formats the code (`.prettierrc`: no semicolons, single quotes, 80 columns) and ESLint checks it
(`eslint.config.js`), with an 80-column limit that also holds for comments; strings, template literals, regexes and
URLs may run longer. `pnpm format` rewrites; `pnpm lint` and `pnpm format:check` verify, and both are part of
`pnpm check`.

## End-to-end tests

`tests/e2e` runs Pacenote the way it runs for real, on this computer and without network access: the bot (and the
team hub) as their own processes, a Slack workspace stand-in they reach through `SLACK_API_URL`, and a stand-in
for the claude CLI. Each test gets its own workspace, data folder and `HOME`, so a real Pacenote running on the same
Mac is never touched.

| Piece | What it is |
| --- | --- |
| `support/fake-slack.ts` | Web API, Socket Mode (events as acked envelopes), file downloads (Slack's login page without access) and uploads, with channels, users and threads behind them |
| `support/fake-claude.mjs` | Answers by rules matched on the request: an answer, a delay, a failure, tool steps. Records each call's prompt, system prompt and images |
| `support/world.ts` | One test's workspace (#ops public, #secret private, alice, bob), the fake claude's rules, and the bot's environment, status and run history |
| `support/processes.ts` | The bot and the hub as processes (from source with tsx; `E2E_BOT=bundle` runs the bot's bundle after `pnpm bundle`) |

| File | Cases |
| --- | --- |
| `bot.e2e.ts` | Answers in a thread and outside one (context, mrkdwn, run history, permalink), long answers, tool steps, the allowlist, private channels, failures, attachments (text, image, files.info lookups, no access), redelivered events, finishing on SIGTERM, resuming after a crash, a rejected token |
| `hub.e2e.ts` | Pairing with a code sent in Slack, a member's mention answered on their desktop through the hub (files included, no Slack token on the desktop), a member without a desktop, a disconnected desktop |
| `app.e2e.ts` | The desktop app (Playwright for Electron): first run, Slack tokens saved from Settings, the connection check, starting the bot, the answered mention in the run history |

`E2E_VERBOSE=1` prints the processes' logs as they run. A failed app test leaves a screenshot in `test-results/`.

Coverage (`pnpm test:e2e:coverage`) is measured with c8 in the bot and hub processes themselves (each writes its V8
coverage, mapped back to the TypeScript through tsx's source maps), over the code those processes run: the bot, the
hub, the messengers, the mention pipeline, the reasoners, history and runtime (`.c8rc.json`). The ops-broker, the
sandbox jobs and the desktop app's own code (the history reader, the connection check, hub pairing) are left out,
since this suite does not run them in those processes; a process killed on purpose (the crash test) leaves no coverage. The report is in `coverage/e2e/` (`index.html`, `lcov.info`).

CI (`.github/workflows/ci.yml`) runs `pnpm check` and `pnpm test:e2e:coverage` on every push to main and pull
request, puts the coverage per folder in the job summary, and keeps the report as the `e2e-coverage` artifact. On
main it also updates the coverage badge above (the `badges` branch). The app test runs on a macOS runner when the
workflow is started by hand.

## Adding a messenger

The mention pipeline (`src/mention`) talks to chat apps only through `Messenger` in `src/messengers/types.ts`, so a new
app is an adapter, not a change to the pipeline:

1. Add its id to `src/messengers/ids.ts`.
2. Write `src/messengers/<id>/`: a `Messenger` (who may ask and where, the readable request and context, file lookups
   and downloads, posting, editing, uploads, rendering Markdown into the app's markup) and a `MessengerConnection` that
   turns the app's events into `Mention`s. `src/messengers/slack/` is the reference.
3. Connect it in `src/index.ts` and pass its messenger to `MentionResponder`.
4. Give its settings groups `messenger: "<id>"` in `src/settings/fields.ts`; the Messengers section shows them under
   the app's heading.

Run history (`origin.messenger`) and interrupted requests (`inflight.json`) already record which messenger a request
came from.
