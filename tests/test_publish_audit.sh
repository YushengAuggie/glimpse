#!/usr/bin/env bash
# Deterministic (no-browser) coverage for auto-audit-on-publish wiring:
# flag/env parsing and the "not watching → stay fast + quiet" skip path. The
# end-to-end warn/gate against a real render lives in the opt-in runtime test
# tests/test_publish_audit_cdp.sh (needs a live `glimpse open`).
#
# We point PORT/CDP at ports nothing is listening on, so `_canvas_live` is false
# and the auto-audit must skip WITHOUT launching Chrome. That keeps this test
# hermetic while still exercising the real dispatcher.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
export GLIMPSE_DIR; GLIMPSE_DIR="$(mktemp -d)"
trap 'rm -rf "$GLIMPSE_DIR"' EXIT
# Unlikely-in-use loopback ports so the canvas reads as "not live".
export GLIMPSE_PORT=49317 GLIMPSE_CDP_PORT=49318
G="$REPO/bin/glimpse"
HTML='<!doctype html><meta charset=utf-8><title>t</title><body><p>hi</p></body>'

run(){ # capture stdout/stderr/rc without tripping set -e
  set +e; "$@" >"$GLIMPSE_DIR/out.txt" 2>"$GLIMPSE_DIR/err.txt"; RC=$?; set -e
}

# 1. plain publish while the canvas is NOT live: publishes, skips audit silently,
#    exits 0, and never blocks on a browser.
run bash -c "printf '%s' '$HTML' | '$G' publish demo 'Demo'"
[ "$RC" -eq 0 ] || { echo "FAIL: publish should exit 0 when canvas down, got $RC"; cat "$GLIMPSE_DIR/err.txt"; exit 1; }
grep -q "published →" "$GLIMPSE_DIR/out.txt" || { echo "FAIL: no publish line"; exit 1; }
[ -f "$GLIMPSE_DIR/artifacts/demo.html" ] || { echo "FAIL: artifact not written"; exit 1; }
[ -s "$GLIMPSE_DIR/err.txt" ] && { echo "FAIL: expected quiet stderr, got:"; cat "$GLIMPSE_DIR/err.txt"; exit 1; }
grep -qi "layout issue" "$GLIMPSE_DIR/out.txt" && { echo "FAIL: audit noise on stdout"; exit 1; }

# 2. --no-audit is accepted and positional args still resolve (slug/title/file).
run bash -c "printf '%s' '$HTML' | '$G' publish demo2 'Demo2' --no-audit"
[ "$RC" -eq 0 ] || { echo "FAIL: --no-audit publish should exit 0, got $RC"; exit 1; }
grep -q "published →" "$GLIMPSE_DIR/out.txt" || { echo "FAIL: --no-audit dropped the publish"; exit 1; }
[ -f "$GLIMPSE_DIR/artifacts/demo2.html" ] || { echo "FAIL: --no-audit must still publish"; exit 1; }

# 3. GLIMPSE_AUDIT=0 also disables auto-audit globally.
run bash -c "printf '%s' '$HTML' | GLIMPSE_AUDIT=0 '$G' publish demo3 'Demo3'"
[ "$RC" -eq 0 ] || { echo "FAIL: GLIMPSE_AUDIT=0 publish should exit 0, got $RC"; exit 1; }
[ -f "$GLIMPSE_DIR/artifacts/demo3.html" ] || { echo "FAIL: GLIMPSE_AUDIT=0 must still publish"; exit 1; }

# 4. usage string documents the new flags.
run "$G" publish
grep -q -- "--gate" "$GLIMPSE_DIR/err.txt" || { echo "FAIL: usage missing --gate"; exit 1; }
grep -q -- "--no-audit" "$GLIMPSE_DIR/err.txt" || { echo "FAIL: usage missing --no-audit"; exit 1; }

# 5. the shared report renderer resolves from this checkout and gates on errors.
BAD='{"slug":"x","viewportWidth":1000,"findings":[{"selector":"div.foo","kind":"element-overflow","overflowPx":40,"severity":"error"}]}'
run bash -c "printf '%s' '$BAD' | MODE=brief SLUG=x node '$REPO/lib/glimpse-audit-report.mjs'"
[ "$RC" -eq 2 ] || { echo "FAIL: brief report should exit 2 on an error finding, got $RC"; exit 1; }
grep -qi "run: glimpse audit x" "$GLIMPSE_DIR/out.txt" || { echo "FAIL: brief report not actionable"; exit 1; }

echo "ALL OK"
