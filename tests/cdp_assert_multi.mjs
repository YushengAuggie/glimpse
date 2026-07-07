// Reads the TOP canvas page's window.__glimpse_audit over CDP and asserts that
// every slug in GX_SLUGS (comma-separated) has its OWN keyed audit entry, present
// SIMULTANEOUSLY. This is the multi-artifact relaxation: the old single latest-buffer
// held one artifact's audit at a time, so viewing a second wiped the first. With the
// per-slug map, both coexist — proving no cross-artifact masking. Env: GX_PORT, GX_SLUGS.
//
// SKIPs (exit 0) when its preconditions are absent — no GX_SLUGS, CDP unreachable, or
// no canvas page open — so a bare `node --test tests/*.mjs` sweep (which passes no env
// and may have no canvas) never turns this into a failure. It only FAILs (exit 1) when
// slugs ARE requested against a live canvas but an expected per-slug audit is missing.
const PORT = process.env.GX_PORT || "4321";
const SLUGS = (process.env.GX_SLUGS || "").split(",").filter(Boolean);
const CDP = "http://127.0.0.1:" + (process.env.GLIMPSE_CDP_PORT || "9222");
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const isCanvas = (u) => { try { const p = new URL(u); return p.protocol === "http:" && LOOPBACK.has(p.hostname) && p.port === String(PORT); } catch { return false; } };

if (!SLUGS.length) { console.log("SKIP: no GX_SLUGS (run via tests/test_multi_artifact_cdp.sh)"); process.exit(0); }

let list;
try { list = await (await fetch(CDP + "/json")).json(); }
catch { console.log("SKIP: no debuggable Chrome on " + CDP); process.exit(0); }
const t = list.find((x) => x.type === "page" && isCanvas(x.url));
if (!t) { console.log("SKIP: no canvas top-page target on port " + PORT); process.exit(0); }

const ws = new WebSocket(t.webSocketDebuggerUrl);
const send = (() => { let id = 0; const p = {}; ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && p[m.id]) p[m.id](m); });
  return (method, params) => new Promise((res) => { const i = ++id; p[i] = res; ws.send(JSON.stringify({ id: i, method, params })); }); })();
await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.result.value;

// Poll: each artifact's auditor posts once layout settles, so give both time to land.
let audit = {};
for (let i = 0; i < 30; i++) {
  const raw = await evalJs("JSON.stringify(window.__glimpse_audit||{})");
  try { audit = JSON.parse(raw); } catch { audit = {}; }
  if (SLUGS.every((s) => audit[s])) break;
  await new Promise((r) => setTimeout(r, 200));
}
ws.close();

let ok = true;
for (const s of SLUGS) {
  const entry = audit[s];
  const good = !!entry && entry.slug === s;
  console.log((good ? "PASS" : "FAIL") + ": window.__glimpse_audit['" + s + "'] present and self-keyed");
  if (!good) ok = false;
}
console.log("keys present: [" + Object.keys(audit).join(", ") + "]");
process.exit(ok ? 0 : 1);
