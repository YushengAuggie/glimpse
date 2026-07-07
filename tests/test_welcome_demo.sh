#!/usr/bin/env bash
# Disk-level (no-browser) coverage for the newcomer onboarding: the first-run
# self-teaching welcome (_maybe_welcome) and the curated `glimpse demo` set
# (_publish_demo_set). Both are the pure-disk halves of `glimpse open`/`glimpse
# demo`, split out precisely so they can be exercised without launching Chrome.
#
# We source bin/glimpse (its dispatch is guarded by BASH_SOURCE==$0, so sourcing
# only loads the functions) and call the helpers directly against an isolated,
# throwaway GLIMPSE_DIR. The examples resolve from this checkout's examples/.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
export GLIMPSE_DIR; GLIMPSE_DIR="$(mktemp -d)"
trap 'rm -rf "$GLIMPSE_DIR"' EXIT
export GLIMPSE_PORT=49317 GLIMPSE_CDP_PORT=49318   # not used (no browser), just pinned

# shellcheck disable=SC1090
source "$REPO/bin/glimpse"

feed_len(){ node -e 'try{console.log((JSON.parse(require("fs").readFileSync(process.env.GLIMPSE_DIR+"/feed.json","utf8")).artifacts||[]).length)}catch{console.log(-1)}'; }
fail(){ echo "FAIL: $1"; exit 1; }

seed_root

# --- 1. fresh canvas is empty -------------------------------------------------
_feed_empty || fail "a freshly-seeded feed should read as empty"

# --- 2. first-run welcome publishes the guide exactly once --------------------
_maybe_welcome || fail "_maybe_welcome should publish on an empty, never-welcomed canvas"
[ -f "$GLIMPSE_DIR/.welcomed" ]                      || fail "welcome should write the .welcomed marker"
[ -f "$GLIMPSE_DIR/artifacts/glimpse-guide.html" ]   || fail "welcome should write the guide artifact"
[ "$(feed_len)" -eq 1 ]                              || fail "welcome should add exactly one feed entry"
_feed_empty && fail "feed should no longer read as empty after the welcome"

# --- 3. welcome is idempotent: a second call is a no-op (never duplicates) -----
if _maybe_welcome; then fail "_maybe_welcome should not re-publish once welcomed"; fi
[ "$(feed_len)" -eq 1 ] || fail "a second welcome must not add a duplicate feed entry"

# --- 4. the marker survives a full clear (dismiss/remove is respected) --------
rm -f "$GLIMPSE_DIR"/artifacts/*.html
echo '{"artifacts":[]}' > "$GLIMPSE_DIR/feed.json"
_feed_empty || fail "feed should be empty again after a full clear"
if _maybe_welcome; then fail "_maybe_welcome must stay quiet after a clear (marker present)"; fi
[ "$(feed_len)" -eq 0 ] || fail "cleared feed must stay empty — no re-welcome"

# --- 5. GLIMPSE_NO_WELCOME=1 opts out even on a pristine canvas ----------------
NEW="$(mktemp -d)"; trap 'rm -rf "$GLIMPSE_DIR" "$NEW"' EXIT
( export GLIMPSE_DIR="$NEW"; source "$REPO/bin/glimpse"; seed_root
  if GLIMPSE_NO_WELCOME=1 _maybe_welcome; then echo "OPTOUT_FAIL"; fi
  node -e 'console.log((JSON.parse(require("fs").readFileSync(process.env.GLIMPSE_DIR+"/feed.json","utf8")).artifacts||[]).length)' ) > "$GLIMPSE_DIR/optout.txt"
grep -q OPTOUT_FAIL "$GLIMPSE_DIR/optout.txt" && fail "GLIMPSE_NO_WELCOME=1 should skip the welcome"
grep -qx 0 "$GLIMPSE_DIR/optout.txt"          || fail "opt-out canvas should stay empty"
[ -f "$NEW/.welcomed" ] && fail "opt-out must not write the .welcomed marker"

# --- 6. `demo` publishes the curated set, idempotent by slug ------------------
DEMO="$(mktemp -d)"; trap 'rm -rf "$GLIMPSE_DIR" "$NEW" "$DEMO"' EXIT
( export GLIMPSE_DIR="$DEMO"; source "$REPO/bin/glimpse"; seed_root
  _publish_demo_set >/dev/null || echo "DEMO_FAIL1"
  a=$(node -e 'console.log((JSON.parse(require("fs").readFileSync(process.env.GLIMPSE_DIR+"/feed.json","utf8")).artifacts||[]).length)')
  _publish_demo_set >/dev/null || echo "DEMO_FAIL2"     # re-run: idempotent by slug
  b=$(node -e 'console.log((JSON.parse(require("fs").readFileSync(process.env.GLIMPSE_DIR+"/feed.json","utf8")).artifacts||[]).length)')
  echo "count1=$a count2=$b" ) > "$DEMO/demo.txt"
cat "$DEMO/demo.txt"
grep -q DEMO_FAIL "$DEMO/demo.txt" && fail "_publish_demo_set should succeed"
grep -qx "count1=3 count2=3" "$DEMO/demo.txt" || fail "demo should publish 3 artifacts and not duplicate on re-run"
for s in glimpse-guide architecture-overview highlight-chat-demo; do
  [ -f "$DEMO/artifacts/$s.html" ] || fail "demo should write artifact $s"
done
[ -f "$DEMO/.welcomed" ] || fail "demo should set the .welcomed marker (user has seen the guide)"

echo "ALL OK"
