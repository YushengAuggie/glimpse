// Connects to the canvas iframe target over CDP and asserts that a node-anchored
// agent reply has rendered inline inside the call-stack node's reply container.
// Mirrors cdp_assert_render.mjs's CDP plumbing.
//
// We identify OUR iframe precisely by its injected config (window.__GLIMPSE__.slug
// === GX_SLUG) — not by content — so a shared canvas showing a different artifact
// (or the same fixture under another slug) can't cause a false match. If the
// canvas is not currently showing our slug (e.g. on a shared canvas the test can't
// drive the visible tab), we SKIP rather than FAIL: exit 0 with a SKIP line.
const CDP = "http://127.0.0.1:" + (process.env.GLIMPSE_CDP_PORT || "9222");
const ANSWER = process.env.GX_ANSWER || "";
const SLUG = process.env.GX_SLUG || "gx-roundtrip";
const list = await (await fetch(CDP + "/json")).json();
const targets = list.filter(x => x.url === "about:srcdoc" && (x.type === "iframe" || x.type === "page"));
if (!targets.length) { console.log("SKIP: no srcdoc iframe target found (canvas not showing an artifact)"); process.exit(0); }

const connect = t => {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const send = (() => { let id = 0; const p = {}; ws.addEventListener("message", e => { const m = JSON.parse(e.data); if (m.id && p[m.id]) p[m.id](m); });
    return (method, params) => new Promise(res => { const id2 = ++id; p[id2] = res; ws.send(JSON.stringify({ id: id2, method, params })); }); })();
  return { ws, send, ready: new Promise(r => ws.addEventListener("open", r)) };
};
const slugExpr = "(window.__GLIMPSE__ && window.__GLIMPSE__.slug) || ''";

// Find the iframe whose injected config slug is ours.
let mine = null;
for (const t of targets) {
  try {
    const c = connect(t); await c.ready; await c.send("Runtime.enable");
    const slug = (await c.send("Runtime.evaluate", { expression: slugExpr, returnByValue: true })).result.result.value;
    if (slug === SLUG) { mine = c; break; }
    c.ws.close();
  } catch {}
}
if (!mine) { console.log("SKIP: canvas is not showing the '" + SLUG + "' artifact (cannot drive the shared view)"); process.exit(0); }

// Poll for the agent reply. The canvas polls threads/<slug>.json (~1.5s) and pushes
// turns into the iframe; the renderer's mountNodeReply hook renders the answer into
// `.gx-replies .gx-reply-agent`. Poll up to ~5s for it to appear AND contain the text.
const evalJs = async expr => (await mine.send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.result.value;
const needle = JSON.stringify(ANSWER.slice(0, 40));
const expr = "(function(){var a=document.querySelector('.gx-replies .gx-reply-agent'); return !!a && a.textContent.indexOf(" + needle + ")>=0;})()";
let ok = false;
for (let i = 0; i < 25 && !ok; i++) {              // ~5s: 25 × 200ms
  ok = await evalJs(expr);
  if (!ok) await new Promise(r => setTimeout(r, 200));
}
console.log((ok ? "PASS" : "FAIL") + ": node reply rendered inline (.gx-replies .gx-reply-agent contains the answer)");
mine.ws.close();
process.exit(ok ? 0 : 1);
