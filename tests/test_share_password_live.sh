#!/usr/bin/env bash
# Live round-trip: a NEW private share with a KNOWN custom password must produce a
# page that (a) rejects a request with no password, (b) rejects a wrong password, and
# (c) serves the content for the correct custom password. This is the real proof that
# a custom share password "takes" end to end.
#
# OPT-IN ONLY. This egresses to the third-party host ht-ml.app, so it self-skips
# unless GLIMPSE_RUNTIME_TESTS=1 (same gate as the live-CDP tests) — CI stays green
# with no network. Readers auth via cookie ht_ml_pwd=<password> (see the html skill
# references/api.md); a protected page returns 401 without the right cookie.
set -euo pipefail

if [ "${GLIMPSE_RUNTIME_TESTS:-}" != "1" ]; then
  echo "SKIP: live share test (set GLIMPSE_RUNTIME_TESTS=1 to run — egresses to ht-ml.app)"
  exit 0
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
export GLIMPSE_DIR; GLIMPSE_DIR="$(mktemp -d)"
trap 'rm -rf "$GLIMPSE_DIR"' EXIT
mkdir -p "$GLIMPSE_DIR/artifacts"
echo '{"artifacts":[]}' > "$GLIMPSE_DIR/feed.json"

# Innocuous content — no security jargon (ht-ml.app content-scans and rejects pages
# that read as credential/phishing pages, which is unrelated to password protection).
slug="pwlive-$$"
printf '<!doctype html><html><head><meta charset=utf8><title>Harbor log</title></head><body><h1>Harbor log</h1><p>Calm water, light easterly breeze.</p></body></html>' \
  | "$REPO/bin/glimpse" publish "$slug" "Harbor log" --no-audit >/dev/null

pw="live-known-pw-$$"
out="$("$REPO/bin/glimpse" share "$slug" --password "$pw" 2>/dev/null)"
url="$(printf '%s' "$out" | sed -n 's/^shared → \(.*\)$/\1/p' | head -1)"
[ -n "$url" ] || { echo "FAIL: no share url; output:"; printf '%s\n' "$out"; exit 1; }
echo "shared → $url  (pw=$pw)"

code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

# Correct password may take a few seconds to become active at the edge — retry briefly.
ok=""
for _ in 1 2 3 4 5 6; do
  sleep 4
  [ "$(code --cookie "ht_ml_pwd=$pw" "$url")" = "200" ] && { ok=1; break; }
done
[ -n "$ok" ] || { echo "FAIL: correct custom password did not grant access (200) within timeout"; exit 1; }

nocookie="$(code "$url")"
wrong="$(code --cookie "ht_ml_pwd=definitely-not-it" "$url")"
[ "$nocookie" = "401" ] || { echo "FAIL: no-password request must be 401, got $nocookie"; exit 1; }
[ "$wrong" = "401" ]    || { echo "FAIL: wrong-password request must be 401, got $wrong"; exit 1; }

echo "PASS: custom share password enforced live (no-cookie 401, wrong 401, correct 200)"
