const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const GX = require(path.join(__dirname, "..", "canvas", "glimpse-explain.js"));

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
