# Homebrew distribution (cask only, no DMG)

This directory is the source of Pacenote's cask in the [Ashon/homebrew-tap](https://github.com/Ashon/homebrew-tap)
repository, which it shares with supragnosis. The tap holds rendered output: every release overwrites
`Casks/pacenote.rb` from the template here, so a change is made here, never in the tap.

- `Casks/pacenote.rb` - the desktop app. Installs the release's signed and notarized `.app.zip` for the
  Mac's arch (`arm64` or `x64`). There is no formula: the app carries the bot, the sandbox jobs and
  Electron's Node, so nothing else needs installing (and no bottle or Xcode check is involved). The
  app is tray-resident, so the cask's `uninstall quit:` quits it around an upgrade (the bot finishes
  its requests first) and brew reopens it afterwards.
- The cask was `verda` until v0.1.2 and `orbly` for v0.2.x. The tap's `cask_renames.json`,
  `{"verda": "pacenote", "orbly": "pacenote"}`, moves existing installs to `pacenote` on `brew upgrade`.
- `update-tap.sh` - after a release, renders the cask into a tap checkout: copies the template, fills
  in the version and both sha256 sums from the release's `.sha256` sidecar files, and fails if a
  placeholder or the template's own version survives. Every sum is fetched before anything is
  written, so a missing asset leaves the tap untouched.

## Per release

1. Bump `version` in `package.json`, `apps/desktop/package.json` and `apps/web/package.json`
   (`tests/packaging.test.ts` holds them equal), and add `docs/releases/v<version>.md`, the release body.
2. Commit (`release: v<version> - ...`) on main, then push an annotated tag:
   `git tag -a v<version> -m v<version> && git push origin v<version>`.
3. The release is built from the tag, signed, notarized and published outside this repository: the GitHub
   Release gets `Pacenote-v<version>-macos-{arm64,x64}.app.zip` with their `.sha256` files, and the tap gets
   `Casks/pacenote.rb`, rendered by this tag's `update-tap.sh`.

To render the cask by hand once a release's zips are published, from a checkout of the same tag:

```sh
git clone git@github.com:Ashon/homebrew-tap && cd homebrew-tap
<this repository>/deploy/homebrew/update-tap.sh v0.3.2 .
git add Casks/pacenote.rb && git commit -m "pacenote v0.3.2" && git push
```

## User install

```sh
brew tap ashon/tap
brew install --cask pacenote
```

- Upgrade with `brew upgrade --cask pacenote`. The cask quits the running app first (the bot gets up to
  20s to finish its requests, and unfinished ones resume on the next start) and brew reopens it.
- `brew uninstall --cask pacenote` removes the app. Config, run history and the sandbox allowlist live in
  `~/.pacenote` and are kept; `--zap` also removes the app's Library folders, still not `~/.pacenote`.

## Local builds

`pnpm package:mac` builds an ad-hoc signed app for this Mac as a release zip (`pnpm package:mac --arch x64`
for Intel) and `pnpm install:mac` unpacks it into `/Applications`; it will not replace a Pacenote installed
with this cask. Only the zip stays in `release/`: the app is assembled in `release/staging.noindex`, which
Spotlight skips, so the build never shows up next to the installed app.
