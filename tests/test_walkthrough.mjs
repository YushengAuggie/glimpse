import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const engine = await import("../lib/glimpse-walkthrough.mjs").catch(() => ({}));
import { fixture, repo, source } from "./walkthrough-fixture.mjs";
test("extracts real source and derives caller block without trusting supplied code", (t) => {
  assert.equal(
    typeof engine.buildSnapshot,
    "function",
    "snapshot engine is required",
  );
  const spec = fixture();
  spec.frames[0].blocks[1].raw = "invented code";
  const built = engine.buildSnapshot(spec, repo(t));
  assert.equal(built.frames[0].blocks[1].raw, "  return child(input);\n}");
  assert.equal(
    built.files["main.js"].hash,
    crypto.createHash("sha256").update(source).digest("hex"),
  );
  assert.deepEqual(engine.callStack(built, "child"), [
    { frame: "entry", block: 1 },
    { frame: "child", block: null },
  ]);
  assert.equal(built.nodes[0].id, "call"); // reserved words are safe with DOM prefixes
  assert.equal(built.frames[0].blocks[0].htmlLines.length, 2);
});
test("rejects invalid source ranges and block references before rendering", (t) => {
  const root = repo(t);
  for (const change of [
    (s) => (s.frames[0].blocks[0].start = 0),
    (s) => (s.frames[0].blocks[1].end = 999),
    (s) => (s.nodes[0].blocks = [7]),
    (s) => (s.frames[0].calls.child = 7),
  ]) {
    const spec = fixture();
    change(spec);
    assert.throws(() => engine.buildSnapshot(spec, root), /range|block/i);
  }
});
test("rejects escaping paths and symlinks", (t) => {
  const root = repo(t);
  const outside = path.join(root, "..", path.basename(root) + "-outside.js");
  fs.writeFileSync(outside, source);
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.symlinkSync(outside, path.join(root, "escape.js"));
  for (const file of ["../" + path.basename(outside), "escape.js", outside]) {
    const spec = fixture();
    spec.frames[0].file = file;
    assert.throws(
      () => engine.buildSnapshot(spec, root),
      /outside|relative|escape/i,
    );
  }
});
test("rejects cycles and ambiguous parentage instead of inventing a call stack", (t) => {
  const root = repo(t);
  const cyclic = fixture();
  cyclic.frames[1].calls.entry = 0;
  assert.throws(() => engine.buildSnapshot(cyclic, root), /cycle/i);
  const ambiguous = fixture();
  ambiguous.frames.push({ ...ambiguous.frames[0], id: "other" });
  assert.throws(
    () => engine.buildSnapshot(ambiguous, root),
    /multiple|ambiguous/i,
  );
});
test("requires example provenance and a real branch reason", (t) => {
  const root = repo(t),
    spec = fixture();
  spec.nodes[0].example = { value: "123" };
  assert.throws(() => engine.buildSnapshot(spec, root), /example|provenance/i);
  const side = fixture();
  side.nodes[1].kind = "side";
  side.nodes[1].gate = "call";
  assert.throws(() => engine.buildSnapshot(side, root), /reason/i);
});
test("HTML highlighting preserves source and escapes markup", (t) => {
  const root = repo(t);
  fs.writeFileSync(
    path.join(root, "main.js"),
    source.replace(
      "const input = value;",
      'const input = "</script><img onerror=oops>";',
    ),
  );
  const snapshot = engine.buildSnapshot(fixture(), root);
  const html = snapshot.frames[0].blocks[0].htmlLines.join("\n");
  assert.doesNotMatch(html, /<\/script>|<img/);
  assert.match(html, /&lt;/);
});
test("public HTML excludes unselected source and refuses selected secrets", (t) => {
  const root = repo(t);
  fs.appendFileSync(
    path.join(root, "main.js"),
    '\nconst secret = "unselected-private-value";\n',
  );
  const saved = engine.buildSnapshot(fixture(), root);
  assert.match(saved.files["main.js"].raw, /unselected-private-value/);
  assert.doesNotMatch(
    engine.wrapArtifact(saved, "tour"),
    /unselected-private-value/,
  );
  const previous = process.env.SECRET_PATTERN;
  process.env.SECRET_PATTERN = "const input";
  try {
    assert.throws(() => engine.wrapArtifact(saved, "tour"), /secret/);
  } finally {
    if (previous === undefined) delete process.env.SECRET_PATTERN;
    else process.env.SECRET_PATTERN = previous;
  }
});
