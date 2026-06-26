// Connects to the canvas iframe target over CDP and asserts the rendered DOM.
const CDP = "http://127.0.0.1:" + (process.env.GLIMPSE_CDP_PORT || "9222");
const list = await (await fetch(CDP + "/json")).json();
// the artifact runs in an iframe with about:srcdoc url
const t = list.find(x => x.url === "about:srcdoc" && x.type === "iframe") || list.find(x => x.url === "about:srcdoc");
if (!t) { console.error("FAIL: no srcdoc iframe target found"); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
const send = (() => { let id = 0; const p = {}; ws.addEventListener("message", e => { const m = JSON.parse(e.data); if (m.id && p[m.id]) p[m.id](m); });
  return (method, params) => new Promise(res => { const id2 = ++id; p[id2] = res; ws.send(JSON.stringify({ id: id2, method, params })); }); })();
await new Promise(r => ws.addEventListener("open", r));
await send("Runtime.enable");
// Runtime.evaluate reply nests as { result: { result: { value } } }.
const evalJs = async expr => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.result.value;

// Structural checks resolve synchronously once the renderer has mounted.
const checks = {
  "fallback hidden": "getComputedStyle(document.getElementById('glimpse-fallback')).display === 'none'",
  "3 tabs": "document.querySelectorAll('.gx-tab').length === 3",
  "callstack default on": "document.querySelector('.gx-view[data-key=callstack]').classList.contains('on')",
  "two nodes": "document.querySelectorAll('.gx-node').length === 2",
  "snippet panel filled": "document.querySelector('.gx-panel pre code').textContent.includes('return go()')",
  // The panel must not be crushed by an over-eager gutter reservation (regression:
  // a fixed 300px margin shrank it to ~120px and clipped the snippet). With no
  // comments the reserved gutter is 0, so the panel keeps its full width.
  "panel not crushed": "document.querySelector('.gx-panel').getBoundingClientRect().width > 280",
  "markdown heading": "!!document.querySelector('.gx-view[data-key=architecture] h3')",
  "ask button present": "!!document.querySelector('.gx-node .gx-ask')"
};
let ok = true;
for (const [name, expr] of Object.entries(checks)) {
  const v = await evalJs(expr);
  console.log((v ? "PASS" : "FAIL") + ": " + name);
  if (!v) ok = false;
}
// Data flow renders lazily when its tab is first shown (rendering while the view
// is display:none collapses the flowchart to a 0-size SVG). Open the tab, then
// poll for a PROPERLY-SIZED diagram — existence alone isn't enough; the old bug
// produced a 16x16 collapsed svg that "existed" but showed nothing.
await evalJs("(function(){var t=[].slice.call(document.querySelectorAll('.gx-tab')).filter(function(e){return e.textContent==='Data flow';})[0]; if(t) t.click(); return !!t;})()");
const mermaidExpr = "(function(){var s=document.querySelector('.gx-view[data-key=dataflow] .mermaid svg'); if(!s) return false; var r=s.getBoundingClientRect(); return r.width>60 && r.height>30 && s.querySelectorAll('.node').length===2;})()";
let mermaid = false;
for (let i = 0; i < 25 && !mermaid; i++) {          // ~5s: 25 × 200ms
  mermaid = await evalJs(mermaidExpr);
  if (!mermaid) await new Promise(r => setTimeout(r, 200));
}
console.log((mermaid ? "PASS" : "FAIL") + ": mermaid rendered a sized svg");
if (!mermaid) ok = false;
ws.close();
process.exit(ok ? 0 : 1);
