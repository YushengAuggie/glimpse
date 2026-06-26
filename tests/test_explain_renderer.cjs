const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const shim = require("./dom-shim.cjs");
global.window = shim.window; global.document = shim.document;
const GX = require(path.join(__dirname, "..", "canvas", "glimpse-explain.js"));

function frag2html(frag) {
  const d = document.createElement("div"); d.appendChild(frag); return d.innerHTML;
}

test("module exports the pure helpers", () => {
  for (const fn of ["escapeHtml", "safeMarkdown", "mermaidSource", "buildAskMessage", "highlightTokens"]) {
    assert.strictEqual(typeof GX[fn], "function", "missing export: " + fn);
  }
});

test("escapeHtml neutralizes HTML metacharacters", () => {
  assert.strictEqual(GX.escapeHtml('<img src=x onerror=1>&"'),
    "&lt;img src=x onerror=1&gt;&amp;&quot;");
  assert.strictEqual(GX.escapeHtml(null), "");
});

test("safeMarkdown renders inline marks as elements, not raw", () => {
  const html = frag2html(GX.safeMarkdown("a **b** and `c` and *d*"));
  assert.match(html, /<strong>b<\/strong>/);
  assert.match(html, /<code>c<\/code>/);
  assert.match(html, /<em>d<\/em>/);
});

test("safeMarkdown escapes embedded HTML", () => {
  const html = frag2html(GX.safeMarkdown("x <script>alert(1)</script>"));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("safeMarkdown allows http/mailto links, rejects javascript:", () => {
  const ok = frag2html(GX.safeMarkdown("[g](https://x.dev)"));
  assert.match(ok, /<a href="https:\/\/x\.dev"[^>]*>g<\/a>/);
  const bad = frag2html(GX.safeMarkdown("[x](javascript:alert(1))"));
  assert.doesNotMatch(bad, /href="javascript:/); // never produces a javascript: href
  assert.doesNotMatch(bad, /<a[\s>]/);           // no anchor element at all for rejected scheme
  assert.match(bad, /\[x\]\(javascript:alert\(1\)\)/); // kept as inert literal text
});

test("safeMarkdown builds headings and list items", () => {
  assert.match(frag2html(GX.safeMarkdown("## Title")), /<h3>Title<\/h3>/);
  assert.match(frag2html(GX.safeMarkdown("- one\n- two")), /<li>one<\/li>\s*<li>two<\/li>/);
});

test("mermaidSource quotes+escapes labels and respects direction", () => {
  const src = GX.mermaidSource({ direction: "TB",
    nodes: [{ id: "a", label: 'A"x' }, { id: "b", label: "B" }],
    edges: [{ from: "a", to: "b", label: "go|now" }] });
  assert.match(src, /^flowchart TB/);
  assert.match(src, /a\["A#quot;x"\]|a\["A&quot;x"\]|a\["A\\?"x"\]/); // internal quote neutralized
  assert.match(src, /a -->\|"go\|now"\| b|a -->\|"go.now"\| b/);     // edge label quoted
});

test("mermaidSource strips init directives and click/href", () => {
  const src = GX.mermaidSource({ nodes: [{ id: "a", label: "%%{init: {'x':1}}%% click a href" }], edges: [] });
  assert.doesNotMatch(src, /%%\{/);
  assert.doesNotMatch(src, /\bclick\b/);
  assert.doesNotMatch(src, /\bhref\b/);
});

test("mermaidSource defaults direction to LR and handles empty", () => {
  assert.match(GX.mermaidSource({ nodes: [], edges: [] }), /^flowchart LR/);
});

test("highlightTokens tags strings and comments and preserves text", () => {
  const toks = GX.highlightTokens('x = "hi" # note', "bash");
  assert.strictEqual(toks.map(t => t.text).join(""), 'x = "hi" # note');
  assert.ok(toks.some(t => t.cls === "str" && t.text.includes("hi")));
  assert.ok(toks.some(t => t.cls === "com" && t.text.includes("note")));
});

test("highlightTokens never loses characters", () => {
  const code = "def f():\n  return '</script>'  // x";
  assert.strictEqual(GX.highlightTokens(code, "python").map(t => t.text).join(""), code);
});

test("buildAskMessage produces the glimpse:annotate envelope with a node anchor", () => {
  const node = { id: "n1", label: "cmd()", file: "bin/glimpse", lines: "1-9", snippet: "x".repeat(5000) };
  const msg = GX.buildAskMessage(node, "why?", "ch-7", "uuid-1");
  assert.strictEqual(msg.type, "glimpse:annotate");
  assert.strictEqual(msg.channelId, "ch-7");
  assert.strictEqual(msg.intent, "ask");
  assert.strictEqual(msg.clientTurnId, "uuid-1");
  assert.deepStrictEqual(msg.anchor, { kind: "node", id: "n1", label: "cmd()", file: "bin/glimpse", lines: "1-9" });
  assert.strictEqual(msg.text, "why?");
  assert.strictEqual(msg.quote.length, 4000); // snippet truncated to the daemon cap
});
