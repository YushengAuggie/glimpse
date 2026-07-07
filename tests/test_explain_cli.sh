#!/usr/bin/env bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
export GLIMPSE_DIR; GLIMPSE_DIR="$(mktemp -d)"
trap 'rm -rf "$GLIMPSE_DIR"' EXIT

SPEC='{"scope":"change","title":"T","callstack":{"entry":"n1","steps":[
  {"id":"n1","label":"f()","file":"a.sh","lines":"1-2","lang":"bash",
   "snippet":"x=\"</script>\"","calls":[]}]}}'

# 1. valid spec publishes and is marked kind=explain
printf '%s' "$SPEC" | "$REPO/bin/glimpse" explain demo "Demo" >"$GLIMPSE_DIR/out.txt"
grep -q "published →" "$GLIMPSE_DIR/out.txt" || { echo "FAIL: no publish line"; exit 1; }
node <<'JS'
const fs = require("fs");
const root = process.env.GLIMPSE_DIR;
const feed = JSON.parse(fs.readFileSync(root + "/feed.json", "utf-8"));
const a = feed.artifacts.find((x) => x.slug === "demo");
if (!a || a.kind !== "explain") { console.error("feed entry not kind=explain: " + JSON.stringify(a)); process.exit(1); }
const html = fs.readFileSync(root + "/artifacts/demo.html", "utf-8");
if (!html.includes('id="glimpse-spec"')) { console.error("no glimpse-spec block"); process.exit(1); }
const region = html.split('id="glimpse-spec">')[1].split("</script>")[0];
if (region.includes("</script>")) { console.error("embedded </script> must be escaped, not literal"); process.exit(1); }
if (!html.includes("\\u003c/script>")) { console.error("embedded </script> must be escaped"); process.exit(1); }
console.log("ok-publish");
JS

# 2. invalid spec exits 2 (spec-content error) with a message, publishes nothing
set +e
echo '{"scope":"change"}' | "$REPO/bin/glimpse" explain bad "Bad" 2>"$GLIMPSE_DIR/err.txt"
rc=$?
set -e
[ "$rc" -eq 2 ] || { echo "FAIL: invalid spec should exit 2, got $rc"; exit 1; }
grep -qi "title is required" "$GLIMPSE_DIR/err.txt" || { echo "FAIL: no validation message"; exit 1; }
[ ! -f "$GLIMPSE_DIR/artifacts/bad.html" ] || { echo "FAIL: invalid spec must not publish"; exit 1; }

# 3. untrusted-shape spec (non-dict edge) exits 2 with a clean message, not a traceback
set +e
echo '{"scope":"change","title":"t","dataflow":{"nodes":[{"id":"a","label":"a"}],"edges":[5]}}' \
  | "$REPO/bin/glimpse" explain bad2 "Bad2" 2>"$GLIMPSE_DIR/err2.txt"
rc=$?
set -e
[ "$rc" -eq 2 ] || { echo "FAIL: bad-shape spec should exit 2, got $rc"; exit 1; }
grep -qi "edges entries must be objects" "$GLIMPSE_DIR/err2.txt" || { echo "FAIL: no shape message"; exit 1; }
grep -qi "Traceback" "$GLIMPSE_DIR/err2.txt" && { echo "FAIL: leaked a Python traceback"; exit 1; }
[ ! -f "$GLIMPSE_DIR/artifacts/bad2.html" ] || { echo "FAIL: bad-shape spec must not publish"; exit 1; }

# 4. spec passed as a file argument (not stdin) publishes the artifact
specfile="$GLIMPSE_DIR/demo2.json"
printf '%s' "$SPEC" >"$specfile"
"$REPO/bin/glimpse" explain demo2 "Demo2" "$specfile" >"$GLIMPSE_DIR/out2.txt"
[ -f "$GLIMPSE_DIR/artifacts/demo2.html" ] || { echo "FAIL: file-arg spec must publish"; exit 1; }

echo "ALL OK"
