#!/usr/bin/env bash
# Multi-artifact isolation on the LIVE canvas (roadmap item K): publish two artifacts,
# view each, and assert their browser→agent state stays keyed per slug with no cross-talk:
#   1. both artifacts' layout audits coexist in window.__glimpse_audit (per-slug map) —
#      the old single latest-buffer held one at a time, so viewing beta wiped alpha;
#   2. `glimpse audit <slug>` returns each artifact's OWN audit (keyed read end-to-end);
#   3. highlight questions on each land in separate threads/<slug>.json (no bleed).
#
# Drives the DEFAULT canvas (~/.glimpse) and ONLY runs when a debuggable Chrome AND the
# canvas server are already up — it never launches Chrome. With neither it SKIPs cleanly
# (exit 0), safe in headless CI. Publishes throwaway mx-alpha/mx-beta artifacts + threads
# and removes both on exit (no residue).
set -euo pipefail
# Opt-in only: this drives a live shared canvas, so a casual `bash tests/*.sh` sweep
# must never touch someone's open canvas. Set GLIMPSE_RUNTIME_TESTS=1 to run.
[ "${GLIMPSE_RUNTIME_TESTS:-}" = "1" ] || { echo "SKIP: runtime CDP test (set GLIMPSE_RUNTIME_TESTS=1 to run)"; exit 0; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${GLIMPSE_PORT:-4321}"
CDP="http://127.0.0.1:${GLIMPSE_CDP_PORT:-9222}"
GLIMPSE="$REPO/bin/glimpse"
A="mx-alpha"; B="mx-beta"

curl -fsS -m 1 "$CDP/json/version" >/dev/null 2>&1 \
  || { echo "SKIP: no debuggable Chrome on $CDP (run: glimpse open)"; exit 0; }
curl -fsS -m 1 "http://127.0.0.1:${PORT}/feed.json" >/dev/null 2>&1 \
  || { echo "SKIP: no canvas server on port $PORT (run: glimpse open)"; exit 0; }

cleanup(){ for s in "$A" "$B"; do "$GLIMPSE" rm "$s" >/dev/null 2>&1 || true; "$GLIMPSE" thread "$s" --clear >/dev/null 2>&1 || true; done; }
trap cleanup EXIT

# Two distinct artifacts (annotate on → the auditor is injected and posts a layout audit).
printf '<!doctype html><meta charset=utf-8><title>Alpha</title><main><h1>Alpha</h1><p>alpha body one two three.</p></main>' | "$GLIMPSE" publish "$A" "Alpha" >/dev/null
printf '<!doctype html><meta charset=utf-8><title>Beta</title><main><h1>Beta</h1><p>beta body four five six.</p></main>'   | "$GLIMPSE" publish "$B" "Beta"  >/dev/null

# Wait for a slug's own audit to land in the top-window per-slug buffer over CDP.
# Returns 0 once window.__glimpse_audit[slug] exists (up to ~10s), else 1.
wait_audit(){ GX_PORT="$PORT" GX_SLUGS="$1" node "$REPO/tests/cdp_assert_multi.mjs" >/dev/null 2>&1; }

# View alpha, then beta — a hash navigation within the SAME loaded canvas doc, so the
# top-window audit buffer persists across the switch and must retain BOTH entries.
# Let the shell's 1.2s feed poll ingest the new artifacts BEFORE navigating (a hash nav
# to a slug the feed hasn't seen yet is a no-op), then wait for each artifact's own audit.
sleep 2
"$GLIMPSE" open "#$A" >/dev/null 2>&1 || true
wait_audit "$A" || sleep 2
"$GLIMPSE" open "#$B" >/dev/null 2>&1 || true
wait_audit "$B" || sleep 2

# (1) both audits coexist, each self-keyed (beta's arrival did NOT wipe alpha's).
GX_PORT="$PORT" GX_SLUGS="$A,$B" node "$REPO/tests/cdp_assert_multi.mjs"

# (3) highlight questions on each artifact stay in their own thread (writer path the
# bridge uses). Do this before the audit re-reads (which reload the page).
uidA="$(SLUG="$A" QUOTE='alpha body' TEXT='what is alpha?' CLIENT_TURN_ID="mx-a-$(date +%s)" ARTIFACT_TS="$(date +%s)" "$GLIMPSE" __thread-add-user "$A" | tail -n1)"
uidB="$(SLUG="$B" QUOTE='beta body'  TEXT='what is beta?'  CLIENT_TURN_ID="mx-b-$(date +%s)" ARTIFACT_TS="$(date +%s)" "$GLIMPSE" __thread-add-user "$B" | tail -n1)"
[ -n "$uidA" ] && [ -n "$uidB" ] || { echo "FAIL: missing turn ids"; exit 1; }
"$GLIMPSE" reply "$A" "alpha is the first artifact" --to "$uidA" >/dev/null
# beta stays unanswered; assert isolation: alpha answered, beta still pending, no bleed.
if "$GLIMPSE" thread "$A" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).turns;const u=t.filter(x=>x.role==="user");const ag=t.filter(x=>x.role==="agent");process.exit(u.length===1&&u[0].status==="answered"&&ag.length===1?0:1)})'; then
  echo "PASS: thread $A isolated + answered"
else echo "FAIL: thread $A not isolated/answered"; exit 1; fi
if "$GLIMPSE" thread "$B" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).turns;const u=t.filter(x=>x.role==="user");process.exit(u.length===1&&u[0].status==="pending"&&t.every(x=>x.role!=="agent")?0:1)})'; then
  echo "PASS: thread $B isolated + still pending"
else echo "FAIL: thread $B leaked alpha's reply"; exit 1; fi

# (2) keyed read end-to-end: each `glimpse audit <slug>` reports its OWN slug.
# (audit reloads the page, so run last.) Accept exit 0 (clean) or 2 (findings). Retry
# a couple of times to absorb the first-render settle race on a freshly navigated tab.
check_slug='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);process.exit(o.slug===process.argv[1]?0:1)}catch(e){process.exit(1)}})'
for s in "$A" "$B"; do
  passed=0
  for attempt in 1 2 3; do
    out="$("$GLIMPSE" audit "$s" 2>/dev/null | tail -n1)" || true
    if echo "$out" | node -e "$check_slug" "$s"; then passed=1; break; fi
    sleep 1
  done
  [ "$passed" = 1 ] && echo "PASS: glimpse audit $s → slug $s" || { echo "FAIL: glimpse audit $s returned wrong/again slug"; exit 1; }
done

echo "OK: multi-artifact isolation verified"
