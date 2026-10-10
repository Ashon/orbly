# Migrating from Orbly or Verda

The project was renamed twice: Verda (v0.1), then Orbly (v0.2), now Pacenote (v0.3), with Pace as the assistant's
name (Pacey in v0.3.0). The repository moved to [Ashon/pacenote](https://github.com/Ashon/pacenote) (old links redirect; for a clone,
`git remote set-url origin git@github.com:Ashon/pacenote.git`). The Homebrew cask is now `pacenote`. An existing Orbly or Verda setup keeps working, with warnings in the bot log and the terminal:

- `ORBLY_*` and `VERDA_*` environment variables (in the environment or in `.env`) are read as their `PACENOTE_*` names
  when those are not set; an `ORBLY_*` value wins over a `VERDA_*` one.
- When `~/.pacenote` does not exist, Pacenote uses `~/.orbly`, or else `~/.verda`. User data is never moved or copied.
- The bot looks for a running bot in all three homes, so an old Verda.app or Orbly.app and the new Pacenote.app never
  connect to Slack at the same time.
- Run history and logs written by Verda and Orbly show in the Pacenote app as they are.
- The broker creates `pacenote/*` branches and still recognizes `orbly/*` and `verda/*` branches as its own.
- The k8s account defaults to `pacenote-ro` in the `pacenote` namespace (`sandbox/k8s/pacenote-ro.yaml`). To keep an
  old account, set `OPS_K8S_SA=orbly-ro` and `OPS_K8S_SA_NAMESPACE=orbly` (or the `verda` ones) in `.env`.

To migrate by hand:

1. Stop the bot (quit Orbly.app or Verda.app, or stop `pnpm dev`).
2. `mv ~/.orbly ~/.pacenote` (or `mv ~/.verda ~/.pacenote`).
3. In `~/.pacenote/.env`, rename the `ORBLY_*` or `VERDA_*` keys to `PACENOTE_*` (for example `ORBLY_DATA_DIR` to
   `PACENOTE_DATA_DIR`). Remove explicit `SANDBOX_IMAGE`, `SANDBOX_NETWORK` or `RENDERER_IMAGE` lines that name
   `orbly-*` or `verda-*` images so the new `pacenote-*` defaults apply, then rebuild the images (Settings > Sandbox, or
   `pnpm sandbox:build` and `pnpm sandbox:up`; `pnpm sandbox:ops-up` for the broker).
4. With Homebrew, once the tap renames the cask, `brew update && brew upgrade` moves `orbly` (and `verda`) to `pacenote`
   and replaces the old app with Pacenote.app. If brew keeps listing the old cask, run
   `brew uninstall --cask orbly && brew install --cask pacenote`. Without Homebrew, remove `/Applications/Orbly.app` and
   install Pacenote.app.
5. In api.slack.com, re-apply `slack-app-manifest.yaml` (app name Pacenote, bot display name Pace), so mentions read
   `@Pace`. A team hub's Slack app gets the same.
6. Start Pacenote. Old images, containers and networks can then be removed (`docker compose -p orbly-sandbox down`,
   `docker image rm orbly-reasoner orbly-renderer orbly-egress-proxy orbly-ops-broker`, and the same for `verda-` ones
   still left).
