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
  "markdown heading": "!!document.querySelector('.gx-view[data-key=architecture] h3')",
  "ask button present": "!!document.querySelector('.gx-node .gx-ask')"
};
// mermaid.run() is async and depends on a live CDN fetch, so the SVG can land
// after the structural DOM is ready. Poll this one check instead of one-shot.
const mermaidExpr = "!!document.querySelector('.mermaid svg')";
let ok = true;
for (const [name, expr] of Object.entries(checks)) {
  const v = await evalJs(expr);
  console.log((v ? "PASS" : "FAIL") + ": " + name);
  if (!v) ok = false;
}
let mermaid = false;
for (let i = 0; i < 25 && !mermaid; i++) {          // ~5s: 25 × 200ms
  mermaid = await evalJs(mermaidExpr);
  if (!mermaid) await new Promise(r => setTimeout(r, 200));
}
console.log((mermaid ? "PASS" : "FAIL") + ": mermaid rendered svg");
if (!mermaid) ok = false;
ws.close();
process.exit(ok ? 0 : 1);
