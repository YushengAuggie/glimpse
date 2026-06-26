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
python3 - <<PY
import json, os
f=json.load(open(os.environ["GLIMPSE_DIR"]+"/feed.json"))
a=next(x for x in f["artifacts"] if x["slug"]=="demo")
assert a.get("kind")=="explain", a
html=open(os.environ["GLIMPSE_DIR"]+"/artifacts/demo.html").read()
assert 'id="glimpse-spec"' in html
region = html.split('id="glimpse-spec">')[1].split("</script>", 1)[0]
assert "</script>" not in region, "embedded </script> must be escaped, not literal"
assert "\\u003c/script>" in html, "embedded </script> must be escaped"
print("ok-publish")
PY

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
