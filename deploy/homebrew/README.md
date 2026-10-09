# Homebrew distribution (cask only, no DMG)

This directory is the source of Orbly's cask in the [Ashon/homebrew-tap](https://github.com/Ashon/homebrew-tap)
repository, which it shares with supragnosis. The tap holds rendered output: every release overwrites
`Casks/orbly.rb` from the template here, so a change is made here, never in the tap.

- `Casks/orbly.rb` - the desktop app. Installs the release's signed and notarized `.app.zip` for the
  Mac's arch (`arm64` or `x64`). There is no formula: the app carries the bot, the sandbox jobs and
  Electron's Node, so nothing else needs installing (and no bottle or Xcode check is involved). The
  app is tray-resident, so the cask's `uninstall quit:` quits it around an upgrade (the bot finishes
  its requests first) and brew reopens it afterwards.
- The cask was `verda` until v0.1.2. Since v0.2.0 the tap has `Casks/orbly.rb` and a `cask_renames.json`
  (`{"verda": "orbly"}`), so `brew upgrade` moves existing installs to `orbly`; `Casks/verda.rb` is gone.
- `update-tap.sh` - after a release, renders the cask into a tap checkout: copies the template, fills
  in the version and both sha256 sums from the release's `.sha256` sidecar files, and fails if a
  placeholder or the template's own version survives. Every sum is fetched before anything is
  written, so a missing asset leaves the tap untouched.

## Per release

1. Bump `version` in `package.json`, `apps/desktop/package.json` and `apps/web/package.json`
   (`tests/packaging.test.ts` holds them equal). Optionally add `docs/releases/v<version>.md`; it
   becomes the release body, otherwise GitHub generates notes.
2. Commit (`release: v<version>`), then push an annotated tag: `git tag -a v<version> -m v<version> && git push origin v<version>`.
3. The release workflow runs:
   - `manifest`: the three package versions equal the tag;
   - `check`: `pnpm check`;
   - `app` (arm64 and x64, both on an Apple silicon runner): `pnpm desktop:build`, then
     `apps/desktop/scripts/package-mac.mjs --arch <arch>` signs with the hardened runtime,
     notarizes, staples and zips (`Orbly-v<version>-macos-<arch>.app.zip` + `.sha256`);
   - `publish`: one GitHub Release with both zips;
   - `tap`: `update-tap.sh` renders `Casks/orbly.rb` into the tap and pushes `orbly v<version>`
     (only that file, rebasing if a supragnosis release pushed first).

If the tap job fails or the token is missing, render it by hand from a checkout of the same tag:

```sh
git clone git@github.com:Ashon/homebrew-tap && cd homebrew-tap
<this repository>/deploy/homebrew/update-tap.sh v0.1.0 .
git add Casks/orbly.rb && git commit -m "orbly v0.1.0" && git push
```

## User install

```sh
brew tap ashon/tap
brew install --cask orbly
```

- Upgrade with `brew upgrade --cask orbly`. The cask quits the running app first (the bot gets up to
  20s to finish its requests, and unfinished ones resume on the next start) and brew reopens it.
- `brew uninstall --cask orbly` removes the app. Config, run history and the sandbox allowlist live in
  `~/.orbly` and are kept; `--zap` also removes the app's Library folders, still not `~/.orbly`.
