#!/usr/bin/env bash
# Runtime CDP test for `glimpse doctor`'s canvas tab-count check (see cmd_doctor).
#
# Contract under test:
#   - With a debuggable Chrome up, doctor prints a labelled "tabs" line reporting the
#     count of open "page" targets.
#   - Under the threshold it is an informational note; over ~8 page tabs it WARNS and
#     suggests `glimpse gc`.
#   - CRITICAL: live tab state is INFORMATIONAL and NEVER fails the run — doctor still
#     exits 0 when the required checks pass, no matter how many tabs are open.
#
# Opt-in only: launches a dedicated debuggable Chrome (NOT the default 9222) + its own
# scratch GLIMPSE_DIR, so a casual `bash tests/*.sh` sweep never touches a real canvas.
set -euo pipefail
[ "${GLIMPSE_RUNTIME_TESTS:-}" = "1" ] || { echo "SKIP: runtime CDP test (set GLIMPSE_RUNTIME_TESTS=1 to run)"; exit 0; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
GLIMPSE="$REPO/bin/glimpse"

export GLIMPSE_DIR; GLIMPSE_DIR="$(mktemp -d)/.glimpse"
export GLIMPSE_CDP_PORT="${GLIMPSE_CDP_PORT_TEST:-9336}"
export GLIMPSE_PORT="${GLIMPSE_PORT_TEST:-4399}"
export GLIMPSE_PROFILE="$GLIMPSE_DIR/chrome-profile"
# Neutralize the launchd check: a real but unrelated broken menu-bar job on the dev
# host must not make the "doctor exits 0" assertion flaky. An empty HOME has no
# com.glimpse.menubar plist, so that branch degrades to an informational note.
export HOME; HOME="$(mktemp -d)"

BASE="http://127.0.0.1:$GLIMPSE_CDP_PORT"
cleanup(){ pkill -f "remote-debugging-port=$GLIMPSE_CDP_PORT" 2>/dev/null || true; }
trap cleanup EXIT
fail(){ echo "FAIL: $*" >&2; exit 1; }

# Open a throwaway about:blank tab (PUT is required on newer Chrome; GET on older).
open_tab(){ curl -fsS -X PUT "$BASE/json/new?about:blank" >/dev/null 2>&1 \
              || curl -fsS "$BASE/json/new?about:blank" >/dev/null 2>&1 || true; }

"$GLIMPSE" chrome >/dev/null 2>&1 || fail "chrome launch failed"

# --- under the threshold: an informational note, no warn, and doctor exits 0 --------
set +e; out="$("$GLIMPSE" doctor 2>&1)"; rc=$?; set -e
[ "$rc" -eq 0 ] || { echo "$out"; fail "doctor should exit 0 with CDP up + few tabs (required checks pass)"; }
echo "$out" | grep -Eq "tabs +[0-9]+ open in canvas Chrome" || { echo "$out"; fail "no tabs count line while CDP is up"; }
if echo "$out" | grep -q "leftover tabs waste memory"; then echo "$out"; fail "warned under the threshold"; fi
echo "ok-note-under-threshold"

# --- over the threshold: warn + gc fix, and STILL exit 0 (live state never fails) ---
for _ in $(seq 1 10); do open_tab; done
set +e; out="$("$GLIMPSE" doctor 2>&1)"; rc=$?; set -e
[ "$rc" -eq 0 ] || { echo "$out"; fail "doctor MUST still exit 0 over the tab threshold — live state never fails the run"; }
echo "$out" | grep -q "leftover tabs waste memory" || { echo "$out"; fail "no warn line over the threshold"; }
echo "$out" | grep -q "glimpse gc" || { echo "$out"; fail "no 'glimpse gc' fix suggested over the threshold"; }
echo "ok-warn-over-threshold-still-exit0"

echo "ALL OK"
