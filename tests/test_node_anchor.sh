#!/usr/bin/env bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
export GLIMPSE_DIR; GLIMPSE_DIR="$(mktemp -d)"; trap 'rm -rf "$GLIMPSE_DIR"' EXIT
mkdir -p "$GLIMPSE_DIR/threads" "$GLIMPSE_DIR/artifacts"

# add a node-anchored user turn via the internal command the bridge uses.
SLUG=demo \
ANCHOR='{"kind":"node","id":"n1","label":"cmd()","file":"bin/glimpse","lines":"1-9"}' \
QUOTE='snippet' TEXT='why?' CLIENT_TURN_ID='c1' ARTIFACT_TS=1 \
  "$REPO/bin/glimpse" __thread-add-user demo >/dev/null

python3 - <<PY
import json, os
t = json.load(open(os.environ["GLIMPSE_DIR"]+"/threads/demo.json"))["turns"][0]
a = t["anchor"]
assert a["kind"] == "node", a
assert a["id"] == "n1", a
assert "occurrence" not in a, "node anchors must not carry occurrence: %r" % a
assert a["label"] == "cmd()" and a["file"] == "bin/glimpse" and a["lines"] == "1-9", a
print("scrub-ok")
PY

# a second question on the SAME node id, then assert _akey groups them (same key).
SLUG=demo ANCHOR='{"kind":"node","id":"n1","label":"cmd()","file":"f","lines":"1"}' \
QUOTE='snip' TEXT='follow up?' CLIENT_TURN_ID='c2' ARTIFACT_TS=1 \
  "$REPO/bin/glimpse" __thread-add-user demo >/dev/null
# reproduce the daemon's _akey to prove both turns share a key (mirrors bin/glimpse _akey)
node -e '
  const fs=require("fs");
  const turns=JSON.parse(fs.readFileSync(process.env.GLIMPSE_DIR+"/threads/demo.json")).turns;
  const akey=a=> (a&&a.kind==="node"&&a.id) ? ("node:"+a.id) : (a&&a.exact) ? (a.exact+"#"+(a.occurrence||0)) : null;
  const keys=turns.filter(t=>t.role==="user").map(t=>akey(t.anchor));
  if(keys.length===2 && keys[0]==="node:n1" && keys[0]===keys[1]) console.log("key-group-ok");
  else { console.error("FAIL keys",keys); process.exit(1); }
'
echo "ALL OK"
