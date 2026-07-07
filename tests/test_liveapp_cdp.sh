#!/usr/bin/env bash
# End-to-end smoke test for the "review a live running app" flow: serve a trivial
# local app, `glimpse open` it, then read / shot / snapshot / click / scroll / wait
# and assert the captured content matches the live page and interaction changes it.
#
# Opt-in only: it launches a dedicated debuggable Chrome (on GLIMPSE_CDP_PORT, NOT
# the default 9222) and its own scratch GLIMPSE_DIR, so a casual `bash tests/*.sh`
# sweep never touches someone's open canvas. Set GLIMPSE_RUNTIME_TESTS=1 to run.
set -euo pipefail
[ "${GLIMPSE_RUNTIME_TESTS:-}" = "1" ] || { echo "SKIP: runtime CDP test (set GLIMPSE_RUNTIME_TESTS=1 to run)"; exit 0; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
GLIMPSE="$REPO/bin/glimpse"

# Dedicated, disposable everything so we never collide with a real glimpse session.
APP_PORT="${LIVEAPP_TEST_PORT:-8931}"
export GLIMPSE_DIR; GLIMPSE_DIR="$(mktemp -d)/.glimpse"
export GLIMPSE_CDP_PORT="${GLIMPSE_CDP_PORT_TEST:-9334}"
export GLIMPSE_PORT="${GLIMPSE_PORT_TEST:-4397}"
export GLIMPSE_PROFILE="$GLIMPSE_DIR/chrome-profile"
APP_DIR="$(mktemp -d)"; SHOT="$(mktemp -t glimpse-liveapp).png"; SHOT_DECOY="$(mktemp -t glimpse-decoy).png"

cleanup(){
  [ -n "${APP_PID:-}" ] && kill "$APP_PID" 2>/dev/null || true
  pkill -f "remote-debugging-port=$GLIMPSE_CDP_PORT" 2>/dev/null || true
  rm -f "$SHOT" "$SHOT_DECOY" 2>/dev/null || true
}
trap cleanup EXIT

fail(){ echo "FAIL: $*" >&2; exit 1; }

# The app page has a solid, known background color (#123456) so a screenshot can be
# verified pixel-exact — it is what BUG-1's regression check samples.
cat > "$APP_DIR/index.html" <<'HTML'
<!doctype html><html><head><meta charset="utf-8"><title>Live App Smoke</title>
<style>html,body{margin:0}body{font-family:system-ui;background:#123456;color:#fff}</style></head>
<body>
<h1 id="hd">Counter</h1>
<p>Count: <span id="count">0</span></p>
<button id="inc">Increment</button>
<div style="height:1500px"></div>
<p id="foot">Bottom marker</p>
<script>
  console.log("app booted");
  document.getElementById('inc').addEventListener('click',()=>{
    const c=document.getElementById('count'); c.textContent=(+c.textContent+1);
  });
</script></body></html>
HTML

# A visually-distinct decoy page (solid #ffcc00) served alongside the app. It is the
# "other tab" that BUG-1's wrong-tab capture would grab.
cat > "$APP_DIR/decoy.html" <<'HTML'
<!doctype html><html><head><meta charset="utf-8"><title>Decoy</title>
<style>html,body{margin:0}body{min-height:100vh;background:#ffcc00}</style></head>
<body><h1>DECOY</h1></body></html>
HTML

# Minimal PNG center-pixel reader (Node stdlib zlib only): un-filters scanlines and
# prints the center pixel as "R G B". We compare rendered-vs-rendered rather than to
# hardcoded CSS colors, because Chrome color-manages the capture (the PNG carries an
# iCCP profile), so #ffcc00 does NOT come back as exactly 255,204,0.
cat > "$APP_DIR/pngcolor.cjs" <<'CJS'
const fs=require('fs'), zlib=require('zlib');
const buf=fs.readFileSync(process.argv[2]);
if(buf.length<8 || buf.readUInt32BE(0)!==0x89504e47){ console.error('not a png'); process.exit(1); }
let off=8,width,height,bitDepth,colorType,idat=[];
while(off+8<=buf.length){
  const len=buf.readUInt32BE(off), type=buf.toString('ascii',off+4,off+8), data=buf.slice(off+8,off+8+len);
  if(type==='IHDR'){ width=data.readUInt32BE(0); height=data.readUInt32BE(4); bitDepth=data[8]; colorType=data[9]; }
  else if(type==='IDAT') idat.push(data);
  else if(type==='IEND') break;
  off+=12+len;
}
if(bitDepth!==8){ console.error('unexpected bitDepth',bitDepth); process.exit(1); }
const bpp = colorType===6?4 : colorType===2?3 : colorType===0?1 : 0;
if(!bpp){ console.error('unsupported colorType',colorType); process.exit(1); }
const raw=zlib.inflateSync(Buffer.concat(idat)), stride=width*bpp, out=Buffer.alloc(height*stride);
let pos=0;
for(let y=0;y<height;y++){
  const ft=raw[pos++];
  for(let x=0;x<stride;x++){
    const v=raw[pos++];
    const a=x>=bpp?out[y*stride+x-bpp]:0, b=y>0?out[(y-1)*stride+x]:0, c=(x>=bpp&&y>0)?out[(y-1)*stride+x-bpp]:0;
    let val;
    switch(ft){
      case 0: val=v; break;
      case 1: val=v+a; break;
      case 2: val=v+b; break;
      case 3: val=v+((a+b)>>1); break;
      case 4: { const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c); val=v+((pa<=pb&&pa<=pc)?a:(pb<=pc)?b:c); break; }
      default: console.error('bad filter',ft); process.exit(1);
    }
    out[y*stride+x]=val&0xff;
  }
}
const cx=width>>1, cy=height>>1, i=cy*stride+cx*bpp;
console.log(`${out[i]} ${out[i+1]} ${out[i+2]}`);
CJS
center_color(){ node "$APP_DIR/pngcolor.cjs" "$1"; }

( cd "$APP_DIR" && python3 -m http.server "$APP_PORT" >/dev/null 2>&1 & echo $! > "$APP_DIR/.pid" )
APP_PID="$(cat "$APP_DIR/.pid")"
for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$APP_PORT/" >/dev/null 2>&1 && break; sleep 0.2; done
curl -fsS "http://127.0.0.1:$APP_PORT/" >/dev/null 2>&1 || fail "demo app did not come up on :$APP_PORT"

APP="http://127.0.0.1:$APP_PORT/"
"$GLIMPSE" open "$APP" >/dev/null 2>&1 || fail "glimpse open <app> failed"

# read (navigate → captures identity, text, and console)
READ="$("$GLIMPSE" read "$APP" 2>/dev/null)"
echo "$READ" | grep -q '"title":"Live App Smoke"' || fail "read title mismatch: $READ"
echo "$READ" | grep -q 'Counter'                  || fail "read text missing page content: $READ"
echo "$READ" | grep -q 'app booted'               || fail "read did not capture console output: $READ"

# snapshot (a11y tree of the live app)
SNAP="$("$GLIMPSE" snapshot 2>/dev/null)"
echo "$SNAP" | grep -q 'button "Increment"' || fail "snapshot missing the button: $SNAP"

# shot (pixels) — the no-URL codepath writes a non-empty file
"$GLIMPSE" shot "$SHOT" >/dev/null 2>&1 || fail "glimpse shot failed"
[ -s "$SHOT" ] || fail "screenshot is empty"

# shot must capture the tab matching the URL, not a re-selected one (BUG-1) --------
# BUG-1: the capture step re-selected its tab independently of the navigate. Its
# deterministic repro is a CANVAS-origin URL: the buggy capture DE-PREFERRED canvas
# tabs and always grabbed a non-canvas tab instead, silently returning a misleading
# image of the wrong page. Set that trap with exactly two tabs — the canvas and a
# visually-distinct decoy — and assert `shot <canvas-url>` and `shot <decoy-url>`
# yield DIFFERENT images. If the canvas shot is wrongly grabbing the decoy, the two
# match and this fails. (Reduce to {canvas, decoy} by closing the launch about:blank,
# so the wrong-tab target is unambiguous.)
CANVAS_URL="http://127.0.0.1:$GLIMPSE_PORT/"
DECOY="http://127.0.0.1:$APP_PORT/decoy.html"
close_blank_tabs(){
  node -e '
    const base="http://127.0.0.1:"+process.env.GLIMPSE_CDP_PORT;
    (async()=>{ const ts=await fetch(base+"/json").then(r=>r.json()).catch(()=>[]);
      for(const t of ts) if(t.type==="page" && /^about:blank/.test(t.url||"")) await fetch(base+"/json/close/"+t.id).catch(()=>{});
    })();' 2>/dev/null || true
}
"$GLIMPSE" open "$CANVAS_URL" >/dev/null 2>&1 || fail "glimpse open <canvas> failed"
"$GLIMPSE" open "$DECOY"      >/dev/null 2>&1 || fail "glimpse open <decoy> failed"
close_blank_tabs
"$GLIMPSE" shot "$SHOT" "$CANVAS_URL" >/dev/null 2>&1 || fail "glimpse shot <canvas> failed"
C="$(center_color "$SHOT")" || fail "could not read canvas screenshot color"
"$GLIMPSE" shot "$SHOT_DECOY" "$DECOY" >/dev/null 2>&1 || fail "glimpse shot <decoy> failed"
D="$(center_color "$SHOT_DECOY")" || fail "could not read decoy screenshot color"
[ "$C" != "$D" ] || fail "shot <canvas-url> captured the decoy tab, not the canvas (both '$C') — BUG-1 (de-prefer-canvas)"

# Re-front the app so the no-URL interaction verbs below act on it.
"$GLIMPSE" open "$APP" >/dev/null 2>&1 || fail "glimpse re-open <app> failed"

# wait + click + verify state change (0 → 2)
"$GLIMPSE" wait "#inc" --timeout 5 >/dev/null 2>&1 || fail "wait #inc timed out"
"$GLIMPSE" click "#inc" >/dev/null 2>&1 || fail "click #inc failed"
"$GLIMPSE" click "#inc" >/dev/null 2>&1 || fail "click #inc failed"
AFTER="$("$GLIMPSE" read 2>/dev/null)"
echo "$AFTER" | grep -q 'Count: 2' || fail "click did not change state (expected Count: 2): $AFTER"

# scroll to the bottom marker
SCROLL="$("$GLIMPSE" scroll '#foot' 2>/dev/null)"
echo "$SCROLL" | grep -q '"ok":true' || fail "scroll into #foot failed: $SCROLL"

# a missing selector must report ok:false and exit non-zero (never a silent success)
if "$GLIMPSE" click '#does-not-exist' >/dev/null 2>&1; then fail "click on a missing selector should exit non-zero"; fi

echo "PASS: live-app review flow (open → read/snapshot/shot → wait/click/scroll) end to end"
