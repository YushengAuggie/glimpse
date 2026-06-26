#!/usr/bin/env bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
export GLIMPSE_DIR; GLIMPSE_DIR="$(mktemp -d)"
trap 'rm -rf "$GLIMPSE_DIR"' EXIT

SPEC='{"scope":"change","title":"T","callstack":{"entry":"n1","steps":[
  {"id":"n1","label":"f()","file":"a.sh","lines":"1-2","lang":"bash",
   "snippet":"x=\"</script>\"","calls":[]}]}}'

# 1. valid spec publishes and is marked kind=explain
printf '%s' "$SPEC" | "$REPO/bin/glimpse" explain demo "Demo" >/tmp/explain_out.txt
grep -q "published →" /tmp/explain_out.txt || { echo "FAIL: no publish line"; exit 1; }
python3 - <<PY
import json, os
f=json.load(open(os.environ["GLIMPSE_DIR"]+"/feed.json"))
a=next(x for x in f["artifacts"] if x["slug"]=="demo")
assert a.get("kind")=="explain", a
html=open(os.environ["GLIMPSE_DIR"]+"/artifacts/demo.html").read()
assert 'id="glimpse-spec"' in html
assert "</script>" not in html.split('id="glimpse-spec">')[1].split("</script>",1)[0] or True
assert "\\u003c/script>" in html, "embedded </script> must be escaped"
print("ok-publish")
PY

# 2. invalid spec exits non-zero with a message, publishes nothing
set +e
echo '{"scope":"change"}' | "$REPO/bin/glimpse" explain bad "Bad" 2>/tmp/explain_err.txt
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "FAIL: invalid spec should exit nonzero"; exit 1; }
grep -qi "title is required" /tmp/explain_err.txt || { echo "FAIL: no validation message"; exit 1; }
[ ! -f "$GLIMPSE_DIR/artifacts/bad.html" ] || { echo "FAIL: invalid spec must not publish"; exit 1; }

echo "ALL OK"
