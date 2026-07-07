// glimpse snapshot — a compact accessibility-tree text view of the current (or a
// given) page, captured over the shared CDP channel for an AI agent's own use.
// The readable, token-efficient sibling of `glimpse shot` (pixels) and
// `glimpse read` (raw innerText): here each visible node is one line with its
// ARIA role, accessible name, useful state, and a short per-snapshot uid, so an
// agent can reason about page structure without a screenshot.
//
// This is the verbatim body passed to run_cdp() (spliced after lib/glimpse-cdp.mjs,
// so cdpConnect/fail are in scope). No import/export — it runs as statements inside
// run_cdp's async IIFE, exactly like the inline read/shot bodies.
//
// Format mirrors chrome-devtools-axi's `snapshot` so agents already used to it feel
// at home:
//     page:
//       title: "…"
//       url: "…"
//       nodes: N
//     snapshot:
//     uid=s0 RootWebArea "Title" url="…"
//       uid=s1 heading "Section" level="2"
//       uid=s2 link "Learn more" url="…"
//
// Read-only: it navigates only when given a URL, never mutates the page.

const url = process.env.URL || "";

// Secret scrubber built from the same high-signal pattern used for thread turns
// (SECRET_PATTERN, exported by bin/glimpse), so a captured accessible name or a
// text-field value can never surface a token the thread store would have redacted.
let secretRe = null;
const pat = process.env.SECRET_PATTERN || "";
if (pat) { try { secretRe = new RegExp("(" + pat + ")", "g"); } catch { secretRe = null; } }
const NAME_CAP = 200;                       // keep names token-efficient
const scrub = (s) => {
  s = (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
  if (secretRe) s = s.replace(secretRe, "[REDACTED]");
  if (s.length > NAME_CAP) s = s.slice(0, NAME_CAP) + "…";
  return s;
};

// Collapse away structural noise (containers with no semantics) but keep walking
// through them so their meaningful descendants are reparented into the visible
// tree — the standard "interesting only" a11y-snapshot shape.
const SKIP_ROLES = new Set([
  "none", "presentation", "generic", "GenericContainer", "InlineTextBox", "LineBreak",
]);
// State properties worth showing per node (booleans printed only when true; the
// rest when present). Kept small so lines stay scannable.
const PROP_KEYS = [
  "level", "checked", "pressed", "expanded", "selected", "disabled", "required",
  "valuemin", "valuemax", "valuetext", "placeholder",
];

// Pure renderer, kept as one self-contained function so tests can exercise it with
// a stubbed CDP channel (see tests/test_snapshot_render.mjs).
function renderAXSnapshot(nodes, meta) {
  const byId = new Map();
  for (const n of nodes) byId.set(n.nodeId, n);
  // Roots = nodes whose parent isn't in the returned set (main document, plus any
  // separately-rooted child frame trees getFullAXTree may hand back).
  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));

  const propVal = (n, key) => {
    if (!n.properties) return undefined;
    const p = n.properties.find((p) => p.name === key);
    return p && p.value ? p.value.value : undefined;
  };

  let seq = 0;
  const lines = [];
  const walk = (n, depth) => {
    const role = (n.role && n.role.value) || "";
    const interesting = !n.ignored && role && !SKIP_ROLES.has(role);
    let childDepth = depth;
    if (interesting) {
      const uid = "s" + seq++;
      let line = "  ".repeat(depth) + "uid=" + uid + " " + role;
      const name = scrub(n.name && n.name.value);
      if (name) line += ' "' + name + '"';
      const val = n.value && n.value.value;
      if (val != null && String(val) !== "") line += ' value="' + scrub(val) + '"';
      for (const k of PROP_KEYS) {
        const v = propVal(n, k);
        if (v === undefined || v === false || v === "false" || v === "") continue;
        line += " " + k + '="' + scrub(v) + '"';
      }
      lines.push(line);
      childDepth = depth + 1;
    }
    for (const cid of n.childIds || []) { const c = byId.get(cid); if (c) walk(c, childDepth); }
  };
  for (const r of roots) walk(r, 0);

  const out = [
    "page:",
    "  title: " + JSON.stringify(scrub(meta.title)),
    "  url: " + JSON.stringify(scrub(meta.url)),
    "  nodes: " + seq,
    "snapshot:",
  ];
  for (const l of lines) out.push(l);
  return out.join("\n");
}

const { send, waitEvent, close } = await cdpConnect((x) => x.type === "page");
await send("Page.enable");
await send("Runtime.enable");
await send("DOM.enable");
if (url) {
  const loaded = waitEvent("Page.loadEventFired", 12000).catch(() => {});
  await send("Page.navigate", { url });
  await loaded;
  await new Promise((r) => setTimeout(r, 300));
}

let title = "", href = "";
try {
  const r = await send("Runtime.evaluate", {
    expression: "JSON.stringify({t:document.title,u:location.href})",
    returnByValue: true,
  });
  const o = JSON.parse(r.result.value); title = o.t || ""; href = o.u || "";
} catch { /* fall back to empty identity */ }

await send("Accessibility.enable");

// getFullAXTree stops at frame boundaries, so on the canvas the published artifact
// (a srcdoc iframe) would show up as a bare `Iframe` leaf. Enumerate every frame,
// fetch each one's tree, and graft each child frame's root under the AX node of the
// iframe element that owns it — so the agent sees the artifact's structure, not
// just that an iframe exists. Same-origin/srcdoc frames descend cleanly; a frame
// whose tree can't be fetched (e.g. a cross-origin OOPIF) is simply left as a leaf.
const { frameTree } = await send("Page.getFrameTree");
const mainId = frameTree.frame.id;
const frameIds = [];
(function collect(ft) { frameIds.push(ft.frame.id); (ft.childFrames || []).forEach(collect); })(frameTree);

const allNodes = [];
const frameRoot = new Map();       // frameId → its RootWebArea node id
const ownerBackend = new Map();    // child frameId → backendNodeId of its <iframe>
for (const fid of frameIds) {
  let res = null;
  try { res = await send("Accessibility.getFullAXTree", { frameId: fid }); } catch { /* skip unreachable frame */ }
  if (!res || !res.nodes) continue;
  const ids = new Set(res.nodes.map((n) => n.nodeId));
  for (const n of res.nodes) {
    allNodes.push(n);
    if (!n.parentId || !ids.has(n.parentId)) frameRoot.set(fid, n.nodeId);
  }
  if (fid !== mainId) {
    try { const o = await send("DOM.getFrameOwner", { frameId: fid }); if (o && o.backendNodeId != null) ownerBackend.set(fid, o.backendNodeId); }
    catch { /* owner may be gone */ }
  }
}
close();

// Stitch child frame roots onto their owning iframe AX node.
const byBackend = new Map();
for (const n of allNodes) if (n.backendDOMNodeId != null) byBackend.set(n.backendDOMNodeId, n);
const byId = new Map();
for (const n of allNodes) byId.set(n.nodeId, n);
for (const [fid, rootId] of frameRoot) {
  if (fid === mainId) continue;
  const owner = byBackend.get(ownerBackend.get(fid));
  const root = byId.get(rootId);
  if (owner && root) { owner.childIds = (owner.childIds || []).concat([rootId]); root.parentId = owner.nodeId; }
}

console.log(renderAXSnapshot(allNodes, { title, url: href }));
