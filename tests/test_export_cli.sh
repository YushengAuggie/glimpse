#!/usr/bin/env bash
# Smoke test for `glimpse export` (offline, no network) and the pre-upload guards
# of `glimpse share` (also offline — nothing here reaches ht-ml.app).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
export GLIMPSE_DIR; GLIMPSE_DIR="$(mktemp -d)"
OUTDIR="$(mktemp -d)"
trap 'rm -rf "$GLIMPSE_DIR" "$OUTDIR"' EXIT
mkdir -p "$GLIMPSE_DIR/artifacts"
echo '{"artifacts":[]}' > "$GLIMPSE_DIR/feed.json"

# a published artifact with a LOCAL image + CSS url + a remote CDN script
GLIMPSE_ARTIFACTS="$GLIMPSE_DIR/artifacts" node <<'JS'
const fs = require("fs"), path = require("path");
const d = process.env.GLIMPSE_ARTIFACTS;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
fs.writeFileSync(path.join(d, "logo.png"), png);
fs.writeFileSync(path.join(d, "demo.html"),
  '<!doctype html><html><head><script src="https://cdn.tailwindcss.com"></script>' +
  '<style>body{background:url(logo.png)}</style></head>' +
  '<body><h1>Hi</h1><img src="logo.png"></body></html>');
JS

OUT="$OUTDIR/demo.export.html"
"$REPO/bin/glimpse" export demo --out "$OUT" >/dev/null

GLIMPSE_OUT="$OUT" node <<'JS'
const fs = require("fs");
const h = fs.readFileSync(process.env.GLIMPSE_OUT, "utf-8");
const need = (cond, msg) => { if (!cond) { console.error(msg); process.exit(1); } };
need(h.includes("data:image/png;base64,"), "local <img> not inlined");
need(!h.includes('src="logo.png"'), "local <img> ref left un-inlined");
need(!h.includes("url(logo.png)"), "css url() not inlined");
need(h.includes("https://cdn.tailwindcss.com"), "remote CDN ref must be preserved");
console.log("export-ok");
JS

# unknown slug fails clearly
if "$REPO/bin/glimpse" export nope 2>/dev/null; then echo "FAIL: export of missing slug should error"; exit 1; fi

# share: --public and --password are mutually exclusive (dies before any network)
if "$REPO/bin/glimpse" share demo --public --password hunter2 2>/dev/null; then
  echo "FAIL: share --public --password should error"; exit 1; fi

# share prints the leaves-your-machine privacy notice (to stderr). Force the
# uploader to refuse offline by pointing it at a non-ht-ml.app host, so this test
# never egresses: the notice must still have been printed before the failure.
notice="$(GLIMPSE_HTML_APP_BASE='https://not-ht-ml.example.com/v1' \
  "$REPO/bin/glimpse" share demo --public 2>&1 1>/dev/null || true)"
echo "$notice" | grep -qi "third-party" || { echo "FAIL: missing privacy notice"; exit 1; }
echo "$notice" | grep -qi "leaves your machine\|leaves your\|PUBLIC" || { echo "FAIL: notice unclear"; exit 1; }

echo "PASS: export self-contained; share guards + privacy notice ok"
