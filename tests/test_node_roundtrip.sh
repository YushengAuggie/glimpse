#!/usr/bin/env bash
# Round-trip: a per-node question threads into threads/<slug>.json (as a node
# anchor), `glimpse reply` answers it, and the answer renders inline inside the
# node's `.gx-replies .gx-reply-agent` container on the canvas.
#
# This drives the DEFAULT canvas (~/.glimpse) and ONLY runs when a debuggable
# Chrome AND the canvas server are already up — it never launches Chrome and
# never re-seeds the canvas. With no Chrome on the CDP port (or no canvas server)
# it SKIPs cleanly (exit 0), so it's safe in headless CI. It publishes a throwaway
# `gx-roundtrip` artifact + thread and removes both on exit (no residue).
set -euo pipefail
# Opt-in only: this drives a live shared canvas, so a casual `bash tests/*.sh`
# sweep must never touch someone's open canvas. Set GLIMPSE_RUNTIME_TESTS=1 to run.
[ "${GLIMPSE_RUNTIME_TESTS:-}" = "1" ] || { echo "SKIP: runtime CDP test (set GLIMPSE_RUNTIME_TESTS=1 to run)"; exit 0; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${GLIMPSE_PORT:-4321}"
CDP="http://127.0.0.1:${GLIMPSE_CDP_PORT:-9222}"
GLIMPSE="$REPO/bin/glimpse"
SLUG="gx-roundtrip"

curl -fsS -m 1 "$CDP/json/version" >/dev/null 2>&1 \
  || { echo "SKIP: no debuggable Chrome on $CDP (run: glimpse open)"; exit 0; }
curl -fsS -m 1 "http://127.0.0.1:${PORT}/feed.json" >/dev/null 2>&1 \
  || { echo "SKIP: no canvas server on port $PORT (run: glimpse open)"; exit 0; }

# Throwaway artifact + thread; clean both up on exit so a real run leaves no residue.
cleanup(){ "$GLIMPSE" rm "$SLUG" >/dev/null 2>&1 || true; "$GLIMPSE" thread "$SLUG" --clear >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Publish the explain artifact (node ids n1/n2 come from the shared fixture) and
# open it on the canvas so the renderer mounts the call-stack view.
"$GLIMPSE" explain "$SLUG" "Round-trip test" "$REPO/tests/fixtures/explain-spec.json" >/dev/null
"$GLIMPSE" open "#$SLUG" >/dev/null 2>&1 || true
sleep 2  # let the canvas poll the feed + mount the call-stack view

# Ask a node-anchored question the way the bridge does (internal writer), capturing
# the turn id, then answer it with `glimpse reply --to <id>`.
ANSWER="Because the entry hands off to go() right away."
uid="$(SLUG="$SLUG" \
  ANCHOR='{"kind":"node","id":"n1","label":"entry()","file":"a.py","lines":"1-3"}' \
  QUOTE='def entry():' TEXT='what does this call?' \
  CLIENT_TURN_ID="rt-$(date +%s)" ARTIFACT_TS="$(date +%s)" \
  "$GLIMPSE" __thread-add-user "$SLUG" | tail -n1)"
[ -n "$uid" ] || { echo "FAIL: no user turn id returned"; exit 1; }
"$GLIMPSE" reply "$SLUG" "$ANSWER" --to "$uid" >/dev/null

# Assert the reply rendered inline under the node (polls inside the iframe via CDP).
GX_ANSWER="$ANSWER" GX_SLUG="$SLUG" node "$REPO/tests/cdp_assert_roundtrip.mjs"
