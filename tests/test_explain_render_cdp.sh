#!/usr/bin/env bash
# Requires a running debuggable Chrome + canvas server (glimpse open). Skips cleanly if absent.
set -euo pipefail
# Opt-in only: this drives a live shared canvas, so a casual `bash tests/*.sh`
# sweep must never touch someone's open canvas. Set GLIMPSE_RUNTIME_TESTS=1 to run.
[ "${GLIMPSE_RUNTIME_TESTS:-}" = "1" ] || { echo "SKIP: runtime CDP test (set GLIMPSE_RUNTIME_TESTS=1 to run)"; exit 0; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
CDP="http://127.0.0.1:${GLIMPSE_CDP_PORT:-9222}"
curl -fsS "$CDP/json/version" >/dev/null 2>&1 || { echo "SKIP: no debuggable Chrome on $CDP (run: glimpse open)"; exit 0; }

"$REPO/bin/glimpse" explain rendertest "Render test" "$REPO/tests/fixtures/explain-spec.json" >/dev/null
"$REPO/bin/glimpse" open '#rendertest' >/dev/null 2>&1 || true
sleep 2  # let the canvas poll + mount + mermaid run

# Evaluate inside the artifact iframe via CDP and print PASS/FAIL lines.
node "$REPO/tests/cdp_assert_render.mjs"
