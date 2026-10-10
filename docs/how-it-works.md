# How it works

What happens between a mention and its answer: context, attachments, diagrams and images, and the reasoner CLIs.

```
@bot mention in a public channel
  -> messenger adapter (Slack: Bolt, Socket Mode or the team hub, app_mention event) -> Mention
  -> check allowed users / public channel
  -> Pace posts "Working on it..." in the thread
  -> collect thread context (the whole thread, or the last 10 messages outside a thread)
  -> Reasoner: claude -p or codex exec (a disposable container when REASONER_SANDBOX=docker)
  -> replace "Working on it..." with the answer (long answers continue in more messages)
```

- A mention inside a thread also passes the bot's earlier answers as context, so it continues from them.
- With `MENTION_ALLOWED_USERS` set, the bot answers only those users. Anyone else gets a message only they
  can see (ephemeral): "I only answer specific people here."
- It does not answer in private channels or DMs.
- It runs up to `MENTION_CONCURRENCY` requests at once and queues up to 10 more. Beyond that it replies that it is busy.
- On failure it replaces the placeholder message with "I couldn't produce an answer." The channel is public, so error
  details go only to the log.

## Attachments
Files attached to the mention and to the thread are downloaded with the bot token (`files:read`) and passed along. Attachments
of the request message come first, then the thread's recent attachments. Files that arrive in the event as a stub
(`file_access: check_file_info`) are fetched again with `files.info`.

| Kind | Handling | Limits |
| --- | --- | --- |
| Images (png, jpg, gif, webp) | codex: read-only `/attachments` mount + `--image`; claude: base64 blocks on stdin | 10MB each, up to 4 |
| Text (logs, config, code, JSON/YAML/CSV, Slack snippets, SVG) | Content goes into the prompt as an `<attached_file>` data section | 2MB and 50,000 characters per file, 120,000 characters in total |
| PDF | Text of the first 50 pages only, extracted in a disposable container with no network (`pdftotext`) | 20MB, up to 4 together with text files |
| Other formats, external files (Google Drive and so on) | Not read; the model is told the name and the reason | |

- Instructions inside attachments are treated as data only. Downloaded files are kept in `PACENOTE_DATA_DIR/attachments/<id>`
  and deleted when the answer is done. (`/tmp` is not used because colima mounts only paths under the home directory into containers.)
- Without the scope, Slack returns a login page instead of the file. This case is reported as "check the files:read scope".

## Diagrams and images
When a diagram helps, the model writes a ` ```mermaid `, ` ```dot ` (graphviz), ` ```vega-lite ` or ` ```svg ` code block.
The bot renders the block as a PNG, posts it to the thread (`files:write`), and leaves only a "(Figure N: image below)" marker in the text.

- Rendering runs in a disposable container with no network (`sandbox/renderer`: mermaid-cli + chromium, graphviz, vl-convert, librsvg,
  Noto CJK fonts). Read-only root, privileges dropped, memory/process limits.
- Up to 3 per answer. A block that cannot be rendered keeps its source with a note, and if the upload fails the source is posted to the thread.
- vega-lite cannot load external data, so values go directly into `data.values`. Without a size, it renders at 520x260.
- `RENDER_DIAGRAMS=off` turns it off. If the renderer image is missing, the startup log says so and the bot works without diagrams.

Illustrations and photo-like images are made with codex's image generation (`image_generation`). (The claude backend has none.)

- codex saves generated images to `~/.codex/generated_images`. In the sandbox container, each request mounts
  `PACENOTE_DATA_DIR/attachments/<id>/generated` at `/out`, and the entrypoint links that path to `/out` so the images stay on the host.
  This is the only path the container can write to on the host.
- After the answer, the bot posts the generated images (up to 4) together with the diagrams to the thread. Generation takes about a minute.
- codex generates only fixed sizes (1024x1024, 1536x1024 and so on), so without a size or aspect request it is asked for a square,
  and before upload the renderer container (Pillow) shrinks the long side to `GENERATED_IMAGE_MAX_PX` (default 512). 0 keeps the original.
- Images already in the thread are passed along, so the model can draw with reference to images posted earlier.

| Path | Role |
| --- | --- |
| `src/index.ts` | App assembly: connects the messenger and hands its mentions to the responder |
| `src/messengers/types.ts` | The messenger interface: receiving mentions, context, files, posting, editing, uploads, formatting, links |
| `src/messengers/slack/` | The Slack adapter: connection (Socket Mode or the team hub), user/channel cache, mrkdwn conversion, file downloads |
| `src/mention/` | The messenger-neutral pipeline: allowlist and venue checks, prompt, attachments, run history, resuming after a restart |
| `src/reasoners/` | The reasoner interface and a `CliAdapter` per CLI (`claude -p`, `codex exec`), run by `cli.ts` |
| `src/sandbox/` | Where the CLI runs: the `Sandbox` interface, `host.ts` and `docker.ts`, plus sandbox setup jobs |
| `src/broker/` | ops-broker: SSH host checks, k8s queries, work directory reads (MCP server) |
| `src/tools/sandbox-job.ts` | Sandbox apply jobs: image builds, proxy, broker (mount preparation, host list), kubeconfig. Shared by the app and `pnpm sandbox:*` |
| `scripts/bundle.mjs` | Bundles the bot, the sandbox jobs and the broker with their dependencies (`pnpm bundle`; used by the packaged app and the broker image) |
| `apps/desktop/scripts/package-mac.mjs` | Installable macOS app and its release zip (`pnpm package:mac`) |
| `src/tools/check-slack.ts` | Slack app config check (`pnpm slack:check`) |
| `sandbox/` | Reasoner container image, egress proxy, compose |
| `deploy/homebrew/` | Homebrew cask template (`Casks/pacenote.rb`), tap update script, release runbook |

## Reasoner backends

| REASONER | Runs | Limits |
| --- | --- | --- |
| `claude` (default) | `claude -p --output-format json` | Does not read user settings, hooks or MCP. No tools by default; with `MENTION_WORKSPACE`, only `Read,Grep,Glob` |
| `codex` | `codex exec --sandbox read-only --ephemeral` | The shell tool cannot be turned off, so it is limited by the read-only sandbox and `approval_policy=never` |
