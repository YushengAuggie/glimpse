#!/usr/bin/env bash
# Runtime CDP test for the tab-leak fix (lib/glimpse-cdp.mjs closeTab + `glimpse gc`).
#
# Contract under test:
#   - A one-shot review verb (read/shot/snapshot) that must OPEN a throwaway tab for a
#     not-yet-open URL CLOSES that tab afterward — it does not leak a tab into the
#     shared canvas Chrome (the bug that grew 31 renderers / ~4GB).
#   - A tab opened with `glimpse open` (or otherwise already present) is REUSED and
#     KEPT by a later shot — one-shot cleanup only touches tabs it created.
#   - `glimpse gc` closes about:blank/about:srcdoc strays by default and keeps real
#     tabs; `glimpse gc --all` also closes non-canvas page tabs.
#
# Opt-in only: launches a dedicated debuggable Chrome (NOT the default 9222) + its own
# scratch GLIMPSE_DIR, so a casual `bash tests/*.sh` sweep never touches a real canvas.
set -euo pipefail
[ "${GLIMPSE_RUNTIME_TESTS:-}" = "1" ] || { echo "SKIP: runtime CDP test (set GLIMPSE_RUNTIME_TESTS=1 to run)"; exit 0; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
GLIMPSE="$REPO/bin/glimpse"

export GLIMPSE_DIR; GLIMPSE_DIR="$(mktemp -d)/.glimpse"
export GLIMPSE_CDP_PORT="${GLIMPSE_CDP_PORT_TEST:-9335}"
export GLIMPSE_PORT="${GLIMPSE_PORT_TEST:-4398}"
export GLIMPSE_PROFILE="$GLIMPSE_DIR/chrome-profile"
APP_SRV_PORT="${TABGC_TEST_PORT:-8932}"
SHOT="$(mktemp -t glimpse-gc).png"

cleanup(){
  [ -n "${APP_PID:-}" ] && kill "$APP_PID" 2>/dev/null || true
  pkill -f "remote-debugging-port=$GLIMPSE_CDP_PORT" 2>/dev/null || true
  rm -f "$SHOT" 2>/dev/null || true
}
trap cleanup EXIT
fail(){ echo "FAIL: $*" >&2; exit 1; }

# Tiny Node static app on a NON-canvas host (its own port), so review verbs must open
# a fresh tab for it. Node-only, matching glimpse's runtime (no python3 dependency).
APP_SRV_PORT="$APP_SRV_PORT" node -e '
  const http=require("http");
  const p={ "/":"<!doctype html><meta charset=utf-8><title>GC App</title><h1>hello</h1>",
            "/other":"<!doctype html><meta charset=utf-8><title>GC Other</title><h1>other</h1>" };
  http.createServer((q,s)=>{ s.writeHead(200,{"content-type":"text/html"}); s.end(p[q.url]||p["/"]); })
      .listen(+process.env.APP_SRV_PORT, "127.0.0.1");
' &
APP_PID=$!
for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$APP_SRV_PORT/" >/dev/null 2>&1 && break; sleep 0.2; done
curl -fsS "http://127.0.0.1:$APP_SRV_PORT/" >/dev/null 2>&1 || fail "test app did not come up on :$APP_SRV_PORT"

APPU="http://127.0.0.1:$APP_SRV_PORT/"

# Count open page targets whose URL contains a substring (node global fetch; N22).
count_url(){ URLPAT="$1" node -e '
  const base="http://127.0.0.1:"+process.env.GLIMPSE_CDP_PORT, pat=process.env.URLPAT;
  (async()=>{ const ts=await fetch(base+"/json").then(r=>r.json()).catch(()=>[]);
    console.log(ts.filter(t=>t.type==="page" && (t.url||"").includes(pat)).length); })();'; }

"$GLIMPSE" chrome >/dev/null 2>&1 || fail "chrome launch failed"

# 1. one-shot shot of a not-yet-open URL must leave NO tab behind ------------------
"$GLIMPSE" shot "$SHOT" "$APPU" >/dev/null 2>&1 || fail "glimpse shot <url> failed"
[ -s "$SHOT" ] || fail "screenshot is empty"
[ "$(count_url "127.0.0.1:$APP_SRV_PORT")" -eq 0 ] || fail "shot leaked its throwaway tab"

# 2. read + snapshot of a not-yet-open URL: same — no leak
"$GLIMPSE" read "${APPU}other" >/dev/null 2>&1 || fail "glimpse read <url> failed"
[ "$(count_url "127.0.0.1:$APP_SRV_PORT")" -eq 0 ] || fail "read leaked its throwaway tab"
"$GLIMPSE" snapshot "${APPU}other" >/dev/null 2>&1 || fail "glimpse snapshot <url> failed"
[ "$(count_url "127.0.0.1:$APP_SRV_PORT")" -eq 0 ] || fail "snapshot leaked its throwaway tab"

# 3. a tab from `glimpse open` is persistent; a reusing shot must KEEP it ----------
"$GLIMPSE" open "$APPU" >/dev/null 2>&1 || fail "glimpse open <url> failed"
[ "$(count_url "127.0.0.1:$APP_SRV_PORT")" -eq 1 ] || fail "open should create exactly one app tab"
"$GLIMPSE" shot "$SHOT" "$APPU" >/dev/null 2>&1 || fail "glimpse shot (reuse) failed"
[ "$(count_url "127.0.0.1:$APP_SRV_PORT")" -eq 1 ] || fail "shot on an opened tab must reuse it, not close it"

# 4. gc default: closes about:blank strays, KEEPS the real app tab -----------------
node -e 'const b="http://127.0.0.1:"+process.env.GLIMPSE_CDP_PORT;
  (async()=>{ await fetch(b+"/json/new?about:blank",{method:"PUT"}).catch(()=>fetch(b+"/json/new?about:blank")); })();' >/dev/null 2>&1 || true
"$GLIMPSE" gc >/dev/null 2>&1 || fail "glimpse gc failed"
[ "$(count_url "about:blank")" -eq 0 ] || fail "gc (default) should close about:blank strays"
[ "$(count_url "127.0.0.1:$APP_SRV_PORT")" -eq 1 ] || fail "gc (default) must NOT close a real app tab"

# 5. gc --all: also closes the non-canvas app tab ----------------------------------
"$GLIMPSE" gc --all >/dev/null 2>&1 || fail "glimpse gc --all failed"
[ "$(count_url "127.0.0.1:$APP_SRV_PORT")" -eq 0 ] || fail "gc --all should close the non-canvas app tab"

echo "PASS: one-shot verbs close throwaway tabs; open/reuse kept; gc prunes strays (--all: non-canvas)"
