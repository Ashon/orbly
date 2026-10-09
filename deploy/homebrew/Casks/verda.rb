# Verda desktop app cask: the signed and notarized .app zips from GitHub Releases, one per arch
# (no DMG). The tap's Casks/verda.rb is rendered from this template by update-tap.sh on every
# release (version and sha256 filled in), so edit it here, never in the tap.
# The app bundles the bot, the sandbox jobs and Electron's Node, so it needs no formula.
cask "verda" do
  arch arm: "arm64", intel: "x64"

  version "0.0.0"
  sha256 arm:   "REPLACE_SHA256_ARM64",
         intel: "REPLACE_SHA256_X64"

  url "https://github.com/Ashon/verda/releases/download/v#{version}/Verda-v#{version}-macos-#{arch}.app.zip"
  name "Verda"
  desc "Slack bot that answers mentions with local claude or codex CLIs in a sandbox"
  homepage "https://github.com/Ashon/verda"

  # Electron 38 and later need macOS 12.
  depends_on macos: :monterey

  app "Verda.app"

  # Tray-resident app: brew never quits a running instance on uninstall or upgrade, which would
  # leave the old process (and the bot it supervises) running from a deleted bundle. quit is
  # upgrade-aware: brew reopens the app after the swap. Quitting lets the bot finish its requests.
  uninstall quit: "io.github.ashon.verda"

  # Config, run history and the sandbox allowlist live in ~/.verda (VERDA_HOME) and are kept.
  zap trash: [
    "~/Library/Application Support/Verda",
    "~/Library/Caches/io.github.ashon.verda",
    "~/Library/HTTPStorages/io.github.ashon.verda",
    "~/Library/Preferences/io.github.ashon.verda.plist",
    "~/Library/Saved Application State/io.github.ashon.verda.savedState",
  ]

  caveats <<~EOS
    Verda runs each answer in a Docker sandbox and uses your local claude or codex CLI login.
    Before the first mention:
      - run Docker (Docker Desktop, OrbStack or colima)
      - log in to claude or codex
      - open Verda, fill in the Slack tokens in Settings, then build the sandbox
        images from the Sandbox tab
    Config and run history are in ~/.verda and are kept when the app is removed.
  EOS
end
