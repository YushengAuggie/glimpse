#!/usr/bin/env bash
# End-to-end smoke test for the "review a live running app" flow: serve a trivial
# local app, `glimpse open` it, then read / shot / snapshot / click / scroll / wait
# and assert the captured content matches the live page and interaction changes it.
#
# Opt-in only: it launches a dedicated debuggable Chrome (on GLIMPSE_CDP_PORT, NOT
# the default 9222) and its own scratch GLIMPSE_DIR, so a casual `bash tests/*.sh`
# sweep never touches someone's open canvas. Set GLIMPSE_RUNTIME_TESTS=1 to run.
set -euo pipefail
[ "${GLIMPSE_RUNTIME_TESTS:-}" = "1" ] || { echo "SKIP: runtime CDP test (set GLIMPSE_RUNTIME_TESTS=1 to run)"; exit 0; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
GLIMPSE="$REPO/bin/glimpse"

# Dedicated, disposable everything so we never collide with a real glimpse session.
APP_PORT="${LIVEAPP_TEST_PORT:-8931}"
export GLIMPSE_DIR; GLIMPSE_DIR="$(mktemp -d)/.glimpse"
export GLIMPSE_CDP_PORT="${GLIMPSE_CDP_PORT_TEST:-9334}"
export GLIMPSE_PORT="${GLIMPSE_PORT_TEST:-4397}"
export GLIMPSE_PROFILE="$GLIMPSE_DIR/chrome-profile"
APP_DIR="$(mktemp -d)"; SHOT="$(mktemp -t glimpse-liveapp).png"

cleanup(){
  [ -n "${APP_PID:-}" ] && kill "$APP_PID" 2>/dev/null || true
  pkill -f "remote-debugging-port=$GLIMPSE_CDP_PORT" 2>/dev/null || true
  rm -f "$SHOT" 2>/dev/null || true
}
trap cleanup EXIT

fail(){ echo "FAIL: $*" >&2; exit 1; }

cat > "$APP_DIR/index.html" <<'HTML'
<!doctype html><html><head><meta charset="utf-8"><title>Live App Smoke</title></head>
<body style="font-family:system-ui">
<h1 id="hd">Counter</h1>
<p>Count: <span id="count">0</span></p>
<button id="inc">Increment</button>
<div style="height:1500px"></div>
<p id="foot">Bottom marker</p>
<script>
  console.log("app booted");
  document.getElementById('inc').addEventListener('click',()=>{
    const c=document.getElementById('count'); c.textContent=(+c.textContent+1);
  });
</script></body></html>
HTML

( cd "$APP_DIR" && python3 -m http.server "$APP_PORT" >/dev/null 2>&1 & echo $! > "$APP_DIR/.pid" )
APP_PID="$(cat "$APP_DIR/.pid")"
for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$APP_PORT/" >/dev/null 2>&1 && break; sleep 0.2; done
curl -fsS "http://127.0.0.1:$APP_PORT/" >/dev/null 2>&1 || fail "demo app did not come up on :$APP_PORT"

APP="http://127.0.0.1:$APP_PORT/"
"$GLIMPSE" open "$APP" >/dev/null 2>&1 || fail "glimpse open <app> failed"

# read (navigate → captures identity, text, and console)
READ="$("$GLIMPSE" read "$APP" 2>/dev/null)"
echo "$READ" | grep -q '"title":"Live App Smoke"' || fail "read title mismatch: $READ"
echo "$READ" | grep -q 'Counter'                  || fail "read text missing page content: $READ"
echo "$READ" | grep -q 'app booted'               || fail "read did not capture console output: $READ"

# snapshot (a11y tree of the live app)
SNAP="$("$GLIMPSE" snapshot 2>/dev/null)"
echo "$SNAP" | grep -q 'button "Increment"' || fail "snapshot missing the button: $SNAP"

# shot (pixels)
"$GLIMPSE" shot "$SHOT" >/dev/null 2>&1 || fail "glimpse shot failed"
[ -s "$SHOT" ] || fail "screenshot is empty"

# wait + click + verify state change (0 → 2)
"$GLIMPSE" wait "#inc" --timeout 5 >/dev/null 2>&1 || fail "wait #inc timed out"
"$GLIMPSE" click "#inc" >/dev/null 2>&1 || fail "click #inc failed"
"$GLIMPSE" click "#inc" >/dev/null 2>&1 || fail "click #inc failed"
AFTER="$("$GLIMPSE" read 2>/dev/null)"
echo "$AFTER" | grep -q 'Count: 2' || fail "click did not change state (expected Count: 2): $AFTER"

# scroll to the bottom marker
SCROLL="$("$GLIMPSE" scroll '#foot' 2>/dev/null)"
echo "$SCROLL" | grep -q '"ok":true' || fail "scroll into #foot failed: $SCROLL"

# a missing selector must report ok:false and exit non-zero (never a silent success)
if "$GLIMPSE" click '#does-not-exist' >/dev/null 2>&1; then fail "click on a missing selector should exit non-zero"; fi

echo "PASS: live-app review flow (open → read/snapshot/shot → wait/click/scroll) end to end"
