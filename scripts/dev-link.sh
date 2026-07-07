#!/usr/bin/env bash
# dev-link.sh — point the served canvas assets in $GLIMPSE_DIR at this checkout,
# so editing canvas/*.js (etc.) is live on the next browser reload instead of
# being shadowed by the seed-once copies in ~/.glimpse (see seed_root in
# bin/glimpse, which only copies an asset when it's missing).
#
#   scripts/dev-link.sh          # symlink the assets → this repo
#   scripts/dev-link.sh unlink   # replace the symlinks with real copies again
#
# Local dev convenience only: it mutates $GLIMPSE_DIR, never the repo. The
# server reads files fresh per request, so once linked the loop is just
# edit → reload the canvas tab.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
GLIMPSE_DIR="${GLIMPSE_DIR:-$HOME/.glimpse}"
MODE="${1:-link}"

# repo-relative source → name served under $GLIMPSE_DIR. Mirrors seed_root.
ASSETS=(
  "canvas/index.html|index.html"
  "canvas/glimpse-annotate.js|glimpse-annotate.js"
  "canvas/glimpse-explain.js|glimpse-explain.js"
  "canvas/glimpse-audit.js|glimpse-audit.js"
  "canvas/favicon.svg|favicon.svg"
  "lib/glimpse-explain.mjs|glimpse-explain.mjs"
  "lib/glimpse-ask.mjs|glimpse-ask.mjs"
  "lib/glimpse-feed.mjs|glimpse-feed.mjs"
  "lib/glimpse-threads.mjs|glimpse-threads.mjs"
  "lib/glimpse-server.mjs|glimpse-server.mjs"
  "lib/glimpse-chrome-profile.mjs|glimpse-chrome-profile.mjs"
  "lib/glimpse-export.mjs|glimpse-export.mjs"
  "lib/glimpse-share.mjs|glimpse-share.mjs"
  "lib/glimpse-audit-report.mjs|glimpse-audit-report.mjs"
  "lib/glimpse-store.mjs|glimpse-store.mjs"
  "lib/glimpse-cdp.mjs|glimpse-cdp.mjs"
  "lib/glimpse-bridge.mjs|glimpse-bridge.mjs"
  "lib/glimpse-poll.mjs|glimpse-poll.mjs"
  "lib/glimpse-snapshot.mjs|glimpse-snapshot.mjs"
)

mkdir -p "$GLIMPSE_DIR"

case "$MODE" in
  link)
    for a in "${ASSETS[@]}"; do
      src="$REPO/${a%%|*}"; dest="$GLIMPSE_DIR/${a##*|}"
      [ -f "$src" ] || { echo "  skip (no source): ${a%%|*}"; continue; }
      ln -sfn "$src" "$dest"
      echo "  linked ${a##*|} → $src"
    done
    echo "✓ canvas assets now served from $REPO — reload the canvas tab to pick up edits."
    ;;
  unlink)
    for a in "${ASSETS[@]}"; do
      src="$REPO/${a%%|*}"; dest="$GLIMPSE_DIR/${a##*|}"
      if [ -L "$dest" ]; then
        rm -f "$dest"
        # restore a real copy so the canvas keeps working after unlinking
        [ -f "$src" ] && cp "$src" "$dest" && echo "  unlinked ${a##*|} (restored real copy)"
      else
        echo "  skip (not a symlink): ${a##*|}"
      fi
    done
    echo "✓ reverted to real copies in $GLIMPSE_DIR."
    ;;
  *)
    echo "usage: $0 [link|unlink]" >&2; exit 1
    ;;
esac
