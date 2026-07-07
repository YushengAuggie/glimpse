#!/usr/bin/env bash
# End-to-end auto-audit-on-publish + gate against a REAL render. Drives the
# DEFAULT canvas (~/.glimpse) and only runs when a debuggable Chrome AND the
# canvas server are already up (glimpse open); SKIPs cleanly otherwise, so it's
# safe in headless CI. Publishes throwaway artifacts and removes them on exit.
set -euo pipefail
# Opt-in only: this drives a live shared canvas, so a casual `bash tests/*.sh`
# sweep must never touch someone's open canvas. Set GLIMPSE_RUNTIME_TESTS=1 to run.
[ "${GLIMPSE_RUNTIME_TESTS:-}" = "1" ] || { echo "SKIP: runtime CDP test (set GLIMPSE_RUNTIME_TESTS=1 to run)"; exit 0; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${GLIMPSE_PORT:-4321}"
CDP="http://127.0.0.1:${GLIMPSE_CDP_PORT:-9222}"
G="$REPO/bin/glimpse"
BAD=pub-audit-bad CLEAN=pub-audit-clean

curl -fsS -m 1 "$CDP/json/version" >/dev/null 2>&1 \
  || { echo "SKIP: no debuggable Chrome on $CDP (run: glimpse open)"; exit 0; }
curl -fsS -m 1 "http://127.0.0.1:${PORT}/feed.json" >/dev/null 2>&1 \
  || { echo "SKIP: no canvas server on port $PORT (run: glimpse open)"; exit 0; }

cleanup(){ "$G" rm "$BAD" "$CLEAN" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# A page far wider than any viewport → guaranteed page-horizontal-overflow (error).
BAD_HTML='<!doctype html><meta charset=utf-8><title>bad</title><body style="margin:0"><div style="width:4000px;height:40px;background:#ccc">overflow</div></body>'
CLEAN_HTML='<!doctype html><meta charset=utf-8><title>ok</title><body style="margin:0"><p style="max-width:600px">tidy paragraph</p></body>'

# 1. bad layout, no gate: publishes (exit 0) and warns on stderr, actionably.
set +e
printf '%s' "$BAD_HTML" | "$G" publish "$BAD" "Bad" >/tmp/pa.out 2>/tmp/pa.err
rc=$?
set -e
[ "$rc" -eq 0 ] || { echo "FAIL: warn-only publish should exit 0, got $rc"; cat /tmp/pa.err; exit 1; }
grep -q "published →" /tmp/pa.out || { echo "FAIL: no publish line on stdout"; exit 1; }
grep -qi "layout issue" /tmp/pa.err || { echo "FAIL: expected an auto-audit warning on stderr"; cat /tmp/pa.err; exit 1; }
grep -qi "glimpse audit $BAD" /tmp/pa.err || { echo "FAIL: warning should point to 'glimpse audit $BAD'"; exit 1; }

# 2. same bad layout WITH the gate: publishes but exits non-zero (flagged).
set +e
printf '%s' "$BAD_HTML" | "$G" publish "$BAD" "Bad" --gate >/tmp/pa2.out 2>/tmp/pa2.err
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "FAIL: --gate must fail on layout errors, got exit 0"; exit 1; }
grep -qi "layout gate" /tmp/pa2.err || { echo "FAIL: gate failure message missing"; cat /tmp/pa2.err; exit 1; }

# 3. GLIMPSE_AUDIT_GATE=1 env is equivalent to --gate.
set +e
printf '%s' "$BAD_HTML" | GLIMPSE_AUDIT_GATE=1 "$G" publish "$BAD" "Bad" >/dev/null 2>/tmp/pa3.err
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "FAIL: GLIMPSE_AUDIT_GATE=1 must fail on layout errors"; exit 1; }

# 4. clean layout: no noise on stderr, and the gate does not trip.
set +e
printf '%s' "$CLEAN_HTML" | "$G" publish "$CLEAN" "Clean" --gate >/tmp/pc.out 2>/tmp/pc.err
rc=$?
set -e
[ "$rc" -eq 0 ] || { echo "FAIL: clean artifact should pass the gate, got $rc"; cat /tmp/pc.err; exit 1; }
grep -qi "layout issue" /tmp/pc.err && { echo "FAIL: clean artifact must be quiet, got:"; cat /tmp/pc.err; exit 1; }

echo "ALL OK"
