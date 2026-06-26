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
  assert.doesNotMatch(bad, /href="javascript:/);
  assert.match(bad, /\[x\]\(javascript:alert\(1\)\)|>x</); // rendered inert (as text or hrefless)
});

test("safeMarkdown builds headings and list items", () => {
  assert.match(frag2html(GX.safeMarkdown("## Title")), /<h3>Title<\/h3>/);
  assert.match(frag2html(GX.safeMarkdown("- one\n- two")), /<li>one<\/li>\s*<li>two<\/li>/);
});
