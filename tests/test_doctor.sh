#!/usr/bin/env bash
# `glimpse doctor` is loud (one ✓/✗ line per check) and exits non-zero when a
# required check fails, so scripts/agents can detect a broken runtime.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
GLIMPSE_DIR="$(mktemp -d)"; export GLIMPSE_DIR
TMP="$(mktemp -d)"
trap 'rm -rf "$GLIMPSE_DIR" "$TMP"' EXIT

# 1. Every core check prints its own labelled line (exit code ignored here — it
#    depends on what's installed on this host).
out="$("$REPO/bin/glimpse" doctor 2>&1 || true)"
for label in bash python3 node chrome "cdp port" server; do
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

echo "ALL OK"
