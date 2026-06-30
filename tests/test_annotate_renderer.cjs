// Unit tests for the pure helpers exported by canvas/glimpse-annotate.js.
// The annotate module is a browser IIFE that bails without a __GLIMPSE__ config,
// but it exports its DOM-only markdown + key helpers before that bail so they can
// be tested here with the same minimal DOM shim the explain renderer test uses.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const shim = require("./dom-shim.cjs");
global.window = shim.window; global.document = shim.document;
const AN = require(path.join(__dirname, "..", "canvas", "glimpse-annotate.js"));

function frag2html(frag) {
  const d = document.createElement("div"); d.appendChild(frag); return d.innerHTML;
}

test("module exports the pure helpers", () => {
  for (const fn of ["safeMarkdown", "appendInline", "shouldSend"]) {
    assert.strictEqual(typeof AN[fn], "function", "missing export: " + fn);
  }
});

test("safeMarkdown renders inline marks as elements, not raw", () => {
  const html = frag2html(AN.safeMarkdown("a **b** and `c` and *d*"));
  assert.match(html, /<strong>b<\/strong>/);
  assert.match(html, /<code>c<\/code>/);
  assert.match(html, /<em>d<\/em>/);
});

test("safeMarkdown escapes embedded HTML (no innerHTML parsing of agent text)", () => {
  const html = frag2html(AN.safeMarkdown("x <script>alert(1)</script>"));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("safeMarkdown allows http/mailto links, rejects javascript:", () => {
  const ok = frag2html(AN.safeMarkdown("[g](https://x.dev)"));
  assert.match(ok, /<a href="https:\/\/x\.dev"[^>]*>g<\/a>/);
  const bad = frag2html(AN.safeMarkdown("[x](javascript:alert(1))"));
  assert.doesNotMatch(bad, /href="javascript:/);
  assert.doesNotMatch(bad, /<a[\s>]/);
  assert.match(bad, /\[x\]\(javascript:alert\(1\)\)/);   // kept as inert literal text
});

test("safeMarkdown builds headings and list items", () => {
  assert.match(frag2html(AN.safeMarkdown("## Title")), /<h3>Title<\/h3>/);
  assert.match(frag2html(AN.safeMarkdown("- one\n- two")), /<li>one<\/li>\s*<li>two<\/li>/);
});

test("shouldSend: plain Enter sends; Shift+Enter newlines", () => {
  assert.strictEqual(AN.shouldSend({ key: "Enter" }), true);
  assert.strictEqual(AN.shouldSend({ key: "Enter", shiftKey: true }), false);
});

test("shouldSend: Cmd/Ctrl+Enter always send", () => {
  assert.strictEqual(AN.shouldSend({ key: "Enter", metaKey: true }), true);
  assert.strictEqual(AN.shouldSend({ key: "Enter", ctrlKey: true }), true);
});

test("shouldSend: IME-composition Enter never sends (CJK candidate selection)", () => {
  assert.strictEqual(AN.shouldSend({ key: "Enter", isComposing: true }), false);
  assert.strictEqual(AN.shouldSend({ key: "Enter", keyCode: 229 }), false);
});

test("shouldSend: non-Enter keys and bad input don't send", () => {
  assert.strictEqual(AN.shouldSend({ key: "a" }), false);
  assert.strictEqual(AN.shouldSend(null), false);
  assert.strictEqual(AN.shouldSend({}), false);
});
