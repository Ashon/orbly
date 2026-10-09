#!/usr/bin/env bash
# Renders the tap's Casks/pacenote.rb for a released tag: copies the template next to this script,
# fills in the version and the per-arch sha256 sums from the release's .sha256 sidecar files, and
# fails if a placeholder or the template's own version survives. The release workflow's tap job runs
# it; to run it by hand, use a checkout of the same tag so the template matches the release:
#   deploy/homebrew/update-tap.sh v0.1.0 path/to/homebrew-tap
set -euo pipefail

TAG="${1:?usage: update-tap.sh vX.Y.Z [tap-dir]}"
TAP_DIR="${2:-.}"
VERSION="${TAG#v}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# RELEASE_BASE overrides where the sidecars come from (a local copy when testing the script).
BASE="${RELEASE_BASE:-https://github.com/Ashon/orbly/releases/download/${TAG}}"

sha_of() { # asset name -> sha256 (the release publishes <asset>.sha256 sidecars)
  local sum
  sum=$(curl -fsSL "${BASE}/$1.sha256" | awk '{print $1}')
  [[ "$sum" =~ ^[0-9a-f]{64}$ ]] || { echo "no sha256 for $1 in ${TAG}" >&2; return 1; }
  echo "$sum"
}

# Every sum is fetched before anything is written, so a missing asset leaves the tap untouched.
arm=$(sha_of "Pacenote-${TAG}-macos-arm64.app.zip")
x64=$(sha_of "Pacenote-${TAG}-macos-x64.app.zip")

CASK="${TAP_DIR}/Casks/pacenote.rb"
mkdir -p "${TAP_DIR}/Casks"
# sed without -i writes to a new file, so BSD and GNU sed behave the same.
sed -e "s/^  version \"[^\"]*\"$/  version \"${VERSION}\"/" \
  -e "s/REPLACE_SHA256_ARM64/${arm}/" \
  -e "s/REPLACE_SHA256_X64/${x64}/" \
  "${HERE}/Casks/pacenote.rb" >"${CASK}"

if grep -n "REPLACE_" "$CASK"; then
  echo "a placeholder survived in ${CASK}" >&2
  exit 1
fi
grep -q "^  version \"${VERSION}\"$" "$CASK" || {
  echo "the version line in ${CASK} is not ${VERSION}" >&2
  exit 1
}
echo "tap updated to ${TAG}: ${CASK}"
