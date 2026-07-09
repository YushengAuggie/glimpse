#!/usr/bin/env bash
# `glimpse doctor` is loud (one ✓/✗ line per check) and exits non-zero when a
# required check fails, so scripts/agents can detect a broken runtime.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
GLIMPSE_DIR="$(mktemp -d)"; export GLIMPSE_DIR
TMP="$(mktemp -d)"
trap 'rm -rf "$GLIMPSE_DIR" "$TMP"' EXIT

# 1. Every core check prints its own labelled line (exit code ignored here — it
#    depends on what's installed on this host). python3 is no longer a core check
#    (glimpse runs on Node + Chrome; python3 is optional, only the macOS menu-bar
#    app uses it) so it is not asserted here.
out="$("$REPO/bin/glimpse" doctor 2>&1 || true)"
for label in bash node chrome "cdp port" server; do
  echo "$out" | grep -q " ${label} " || { echo "FAIL: no check line for '$label'"; echo "$out"; exit 1; }
done
echo "ok-format"

# 2. A too-old node is flagged with a fix and makes doctor exit non-zero.
fake="$TMP/bin"; mkdir -p "$fake"
cat > "$fake/node" <<'SH'
#!/bin/sh
case "$1" in --version) echo v18.0.0;; *) exit 1;; esac
SH
chmod +x "$fake/node"
set +e
out="$(PATH="$fake:$PATH" GLIMPSE_NODE=/nonexistent "$REPO/bin/glimpse" doctor 2>&1)"
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "FAIL: doctor should exit non-zero when node is too old"; echo "$out"; exit 1; }
echo "$out" | grep -Eq "node .*too old"        || { echo "FAIL: node not flagged too old"; echo "$out"; exit 1; }
echo "$out" | grep -Eq "brew install node|nodejs.org" || { echo "FAIL: no node fix printed"; echo "$out"; exit 1; }
echo "ok-exit-nonzero"

# 3. Canvas tab-count check is INFORMATIONAL and placed right after the cdp-port check.
#    Behaviour depends on live CDP state (the live warn path is covered, opt-in, by
#    tests/test_doctor_tabs_cdp.sh). Here — with no debuggable Chrome, the hosted-CI
#    default — the existing cdp-port note already covers "down", so there must be NO
#    extra tabs line and NO duplicated down message. On a dev box where CDP happens to
#    be up, a labelled tabs line must instead report the count.
out="$("$REPO/bin/glimpse" doctor 2>&1 || true)"
if echo "$out" | grep -q "no debuggable Chrome on"; then
  if echo "$out" | grep -q "open in canvas Chrome"; then
    echo "FAIL: tabs line printed while CDP is down (down note already covers it)"; echo "$out"; exit 1; fi
  [ "$(echo "$out" | grep -c "no debuggable Chrome on")" -eq 1 ] || {
    echo "FAIL: cdp-down message duplicated"; echo "$out"; exit 1; }
  echo "ok-tabs-absent-when-cdp-down"
else
  echo "$out" | grep -Eq "tabs +[0-9]+ open in canvas Chrome" || {
    echo "FAIL: no tabs count line while CDP is up"; echo "$out"; exit 1; }
  echo "ok-tabs-present-when-cdp-up"
fi

echo "ALL OK"
