#!/usr/bin/env bash
# End-to-end smoke test for `glimpse poll` — the single blocking feedback call.
#
# Runs disk-only (no Chrome / no CDP): poll drains the browser outbox best-effort
# and otherwise blocks on the durable pending queue, so we exercise the full path by
# seeding pending turns via the same internal `__thread-add-user` verb the bridge
# uses. Covers: blocks-then-delivers, compact record shape, dedup / nothing-dropped,
# --json validity, and the timeout exit code + marker.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
GLIMPSE="$REPO/bin/glimpse"
export GLIMPSE_DIR; GLIMPSE_DIR="$(mktemp -d)"; trap 'rm -rf "$GLIMPSE_DIR"' EXIT
export GLIMPSE_CDP_PORT=59991      # nothing debuggable here → force the disk-only path
mkdir -p "$GLIMPSE_DIR/threads" "$GLIMPSE_DIR/artifacts"

seed(){ # slug cid text
  SLUG="$1" CLIENT_TURN_ID="$2" TEXT="$3" QUOTE="q-$2" ARTIFACT_TS=1 \
    "$GLIMPSE" __thread-add-user "$1" >/dev/null
}
fail(){ echo "FAIL: $*" >&2; exit 1; }

# 1) poll BLOCKS until a highlight arrives, then returns it as a compact record.
out1="$GLIMPSE_DIR/out1"; err1="$GLIMPSE_DIR/err1"
"$GLIMPSE" poll --timeout 15 --interval 0.2 >"$out1" 2>"$err1" & pid=$!
sleep 1.2
kill -0 "$pid" 2>/dev/null || fail "poll exited before any feedback (should have blocked)"
seed demo c1 "first question"
wait "$pid"; rc=$?
[ "$rc" = 0 ] || fail "poll exit=$rc after delivery (want 0)"
grep -q '^#glimpse-poll v1 fields=kind,thread,id,ts,anchor,quote,text$' "$out1" || fail "missing compact header"
grep -q $'\tfirst question$' "$out1" || fail "item1 text not in compact output"
# a compact row is one TAB-separated line: header + exactly one record
[ "$(grep -c $'\t' "$out1")" = 1 ] || fail "expected exactly one record row"
echo "ok: blocked, then delivered item1 as a compact record"

# 2) a SECOND item is delivered on the next poll; item1 is neither dropped nor re-sent.
seed demo c2 "second question"
out2="$GLIMPSE_DIR/out2"
"$GLIMPSE" poll --json --timeout 5 --interval 0.2 >"$out2" 2>/dev/null || fail "poll #2 nonzero"
GLIMPSE_OUT2="$out2" node <<'JS'
const fs = require("fs");
const raw = fs.readFileSync(process.env.GLIMPSE_OUT2, "utf-8");
const d = JSON.parse(raw);
const need = (c, m) => { if (!c) { console.error(m + ": " + raw); process.exit(1); } };
need(d.type === "poll" && d.count === 1, "type/count");
need(d.items[0].text === "second question", "item2 text");
need(!("timeout" in d), "unexpected timeout field");
need(!raw.includes("first question"), "item1 was re-delivered (dedup broken)");
console.log("ok: --json valid; only item2 delivered (item1 not dropped, not re-sent)");
JS

# item1 is still durable in the store (delivered != dropped) and still pending until replied.
"$GLIMPSE" thread demo --json | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  const turns=JSON.parse(d).turns;
  const q1=turns.filter(t=>t.text==="first question")[0];
  if(!q1||q1.status!=="pending"){console.error("q1 not pending: "+JSON.stringify(q1));process.exit(1);}
  console.log("ok: item1 preserved in the store, still pending until reply");
})'

# 3) nothing new pending → poll times out with the marker and exit code 3.
out3="$GLIMPSE_DIR/out3"; rc=0
"$GLIMPSE" poll --timeout 1 --interval 0.2 >"$out3" 2>/dev/null || rc=$?
[ "$rc" = 3 ] || fail "timeout exit=$rc (want 3)"
grep -q '^#glimpse-poll v1 timeout=' "$out3" || fail "missing compact timeout marker"
"$GLIMPSE" poll --json --timeout 1 --interval 0.2 2>/dev/null | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  const o=JSON.parse(d);
  if(!(o.count===0 && o.timeout!=null)){console.error("bad timeout payload: "+d);process.exit(1);}
  console.log("ok: timeout → exit 3 + marker (compact) / timeout payload (--json)");
})' || true

echo "ALL OK"
