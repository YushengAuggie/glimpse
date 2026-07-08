#!/usr/bin/env bash
# Smoke test for the shares store + `glimpse shares` retrieval (offline, no network).
# Seeds shares.json via the store module (as cmd_share would after a real upload),
# then drives the retrieval verb and the --update precondition — nothing reaches
# ht-ml.app here.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
export GLIMPSE_DIR; GLIMPSE_DIR="$(mktemp -d)"
trap 'rm -rf "$GLIMPSE_DIR"' EXIT
mkdir -p "$GLIMPSE_DIR/artifacts"
echo '{"artifacts":[]}' > "$GLIMPSE_DIR/feed.json"
echo '<!doctype html><html><body><h1>Hi</h1></body></html>' > "$GLIMPSE_DIR/artifacts/arch.html"

# No shares yet.
"$REPO/bin/glimpse" shares | grep -qi "no shares" || { echo "FAIL: empty list wrong"; exit 1; }
"$REPO/bin/glimpse" shares --json | grep -q '"shares":\[\]' || { echo "FAIL: empty --json wrong"; exit 1; }

# Record a private share exactly as cmd_share does after a successful upload.
SLUG=arch URL="https://arch1.ht-ml.app/" SITE_ID=arch1 UPDATE_KEY=uk-secret \
  VISIBILITY=private PASSWORD=hunter2 TS=1751000000 \
  node "$REPO/lib/glimpse-shares.mjs" record

# shares.json must exist and be 0600 (holds the update_key + password). Read the
# mode via node so the check is portable across GNU (stat -c) and BSD (stat -f) stat.
[ -f "$GLIMPSE_DIR/shares.json" ] || { echo "FAIL: shares.json not written"; exit 1; }
mode="$(node -e 'process.stdout.write((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$GLIMPSE_DIR/shares.json")"
[ "$mode" = "600" ] || { echo "FAIL: shares.json mode $mode (want 600)"; exit 1; }

# List shows it; per-slug shows url + update key + password.
"$REPO/bin/glimpse" shares | grep -q "arch1.ht-ml.app" || { echo "FAIL: list missing url"; exit 1; }
out="$("$REPO/bin/glimpse" shares arch)"
echo "$out" | grep -q "https://arch1.ht-ml.app/" || { echo "FAIL: show missing url"; exit 1; }
echo "$out" | grep -q "uk-secret"               || { echo "FAIL: show missing update key"; exit 1; }
echo "$out" | grep -q "hunter2"                  || { echo "FAIL: show missing password"; exit 1; }

# --json round-trips the record.
"$REPO/bin/glimpse" shares arch --json | grep -q '"update_key":"uk-secret"' \
  || { echo "FAIL: --json record wrong"; exit 1; }

# Unknown slug fails clearly.
if "$REPO/bin/glimpse" shares ghost 2>/dev/null; then echo "FAIL: unknown slug should error"; exit 1; fi

# --update requires a prior record: an un-shared slug must be refused BEFORE any upload.
echo '<html></html>' > "$GLIMPSE_DIR/artifacts/fresh.html"
if "$REPO/bin/glimpse" share fresh --update 2>/dev/null; then
  echo "FAIL: --update without a prior share should error"; exit 1; fi

echo "PASS: shares store persist + retrieve + 0600 + --update precondition ok"
