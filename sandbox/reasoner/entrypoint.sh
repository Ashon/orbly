#!/bin/sh
# HOME is an empty tmpfs every time. Creates the CLI state directories and, if the codex auth file is mounted,
# uses a copy of it. (Token refreshes do not change the host file)
# /out is the only writable path that passes this request's output (generated images) to the host.
set -eu
mkdir -p "$HOME/.claude" "$HOME/.codex"
if [ -f /run/secrets/codex-auth.json ]; then
  cp /run/secrets/codex-auth.json "$HOME/.codex/auth.json"
  chmod 600 "$HOME/.codex/auth.json"
fi
# If /out is mounted, images codex generates (~/.codex/generated_images) are kept there.
if [ -d /out ]; then
  ln -sfn /out "$HOME/.codex/generated_images"
fi
exec "$@"
