// Port of tests/test_glimpse_explain.py to node:test, exercising lib/glimpse-explain.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  validate,
  wrapArtifact,
  truncateSnippet,
  SpecError,
  SNIPPET_MAX_LINES,
  SNIPPET_MAX_BYTES,
} from "../lib/glimpse-explain.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(__dirname, "..", "lib", "glimpse-explain.mjs");

function goodSpec() {
  return {
    scope: "change",
    title: "Daemon path",
    architecture: {
      summary: "x",
      components: [
        { id: "daemon", name: "daemon", role: "answers", files: ["bin/glimpse"] },
      ],
    },
    dataflow: {
      nodes: [
        { id: "daemon", label: "daemon" },
        { id: "proxy", label: "proxy" },
      ],
      edges: [{ from: "daemon", to: "proxy", label: "POST" }],
    },
    callstack: {
      entry: "n1",
      steps: [
        {
          id: "n1",
          label: "cmd_daemon()",
          file: "bin/glimpse",
          lines: "1-9",
          lang: "bash",
          snippet: "x",
          calls: ["n2"],
        },
        {
          id: "n2",
          label: "answer()",
          file: "bin/glimpse",
          lines: "10-20",
          lang: "bash",
          snippet: "y",
          calls: [],
        },
      ],
    },
  };
}

test("good spec passes", () => {
  assert.strictEqual(validate(goodSpec()), true);
});

test("missing title fails", () => {
  const s = goodSpec();
  delete s.title;
  assert.throws(() => validate(s), SpecError);
});

test("bad scope fails", () => {
  const s = goodSpec();
  s.scope = "everything";
  assert.throws(() => validate(s), SpecError);
});

test("no views fails", () => {
  assert.throws(() => validate({ scope: "change", title: "t" }), SpecError);
});

test("one view passes", () => {
  assert.strictEqual(
    validate({
      scope: "change",
      title: "t",
      callstack: {
        entry: "n1",
        steps: [{ id: "n1", label: "f", snippet: "x", calls: [] }],
      },
    }),
    true,
  );
});

test("bad id charset fails", () => {
  const s = goodSpec();
  s.callstack.steps[0].id = "n 1";
  assert.throws(() => validate(s), SpecError);
});

test("reserved word id fails", () => {
  const s = goodSpec();
  s.callstack.steps[0].id = "end";
  s.callstack.entry = "end";
  s.callstack.steps[1].calls = [];
  s.callstack.steps[0].calls = [];
  assert.throws(() => validate(s), SpecError);
});

test("dangling call fails", () => {
  const s = goodSpec();
  s.callstack.steps[0].calls = ["nope"];
  assert.throws(() => validate(s), SpecError);
});

test("dangling entry fails", () => {
  const s = goodSpec();
  s.callstack.entry = "nope";
  assert.throws(() => validate(s), SpecError);
});

test("entry with empty steps fails", () => {
  const s = goodSpec();
  s.callstack.entry = "n1";
  s.callstack.steps = [];
  assert.throws(() => validate(s), SpecError);
});

test("dangling edge fails", () => {
  const s = goodSpec();
  s.dataflow.edges[0].to = "nope";
  assert.throws(() => validate(s), SpecError);
});

test("duplicate id fails", () => {
  const s = goodSpec();
  s.callstack.steps[1].id = "n1";
  assert.throws(() => validate(s), SpecError);
});

test("nodes not a list fails", () => {
  const s = goodSpec();
  s.dataflow.nodes = 5;
  assert.throws(() => validate(s), SpecError);
});

test("components not a list fails", () => {
  const s = goodSpec();
  s.architecture.components = "x";
  assert.throws(() => validate(s), SpecError);
});

test("steps not a list fails", () => {
  const s = goodSpec();
  s.callstack.steps = 5;
  assert.throws(() => validate(s), SpecError);
});

test("edges not a list fails", () => {
  const s = goodSpec();
  s.dataflow.edges = "x";
  assert.throws(() => validate(s), SpecError);
});

test("calls not a list fails", () => {
  const s = goodSpec();
  s.callstack.steps[0].calls = "n2";
  assert.throws(() => validate(s), SpecError);
});

test("non dict edge entry fails", () => {
  const s = goodSpec();
  s.dataflow.edges = [5];
  assert.throws(() => validate(s), SpecError);
});

test("null edge entry fails", () => {
  const s = goodSpec();
  s.dataflow.edges = [null];
  assert.throws(() => validate(s), SpecError);
});

test("calls falsy int 0 fails", () => {
  const s = goodSpec();
  s.callstack.steps[0].calls = 0;
  assert.throws(() => validate(s), SpecError);
});

test("calls false fails", () => {
  const s = goodSpec();
  s.callstack.steps[0].calls = false;
  assert.throws(() => validate(s), SpecError);
});

test("null entry with steps fails", () => {
  const s = goodSpec();
  s.callstack.entry = null;
  assert.throws(() => validate(s), SpecError);
});

test("short snippet unchanged", () => {
  assert.strictEqual(truncateSnippet("a\nb\nc"), "a\nb\nc");
});

test("long snippet truncated with marker", () => {
  const src = Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n");
  const out = truncateSnippet(src);
  assert.ok((out.match(/\n/g) || []).length <= SNIPPET_MAX_LINES + 1);
  assert.ok(out.includes("truncated — showing 200 of 500 lines"));
});

test("non string snippet becomes empty", () => {
  assert.strictEqual(truncateSnippet(null), "");
});

test("byte only cut reports real surviving line count", () => {
  const src = Array.from({ length: 100 }, () => "x".repeat(250)).join("\n");
  const out = truncateSnippet(src);
  const cut = out.lastIndexOf("\n// … ");
  const body = out.slice(0, cut);
  const marker = out.slice(cut + "\n// … ".length);
  const surviving = (body.match(/\n/g) || []).length + 1;
  assert.ok(surviving < 100, "the byte cut dropped whole lines");
  assert.ok(marker.includes(`showing ${surviving} of 100 lines, 16 KB cap`));
  assert.ok(Buffer.byteLength(body, "utf8") <= SNIPPET_MAX_BYTES);
});

test("both caps marker reports actual surviving lines", () => {
  const src = Array.from({ length: 250 }, () => "x".repeat(200)).join("\n");
  const out = truncateSnippet(src);
  const cut = out.lastIndexOf("\n// … ");
  const body = out.slice(0, cut);
  const marker = out.slice(cut + "\n// … ".length);
  const surviving = (body.match(/\n/g) || []).length + 1;
  assert.ok(surviving < SNIPPET_MAX_LINES, "fewer than 200 lines survived");
  assert.ok(marker.includes(`showing ${surviving} of 250 lines`));
  assert.ok(Buffer.byteLength(body, "utf8") <= SNIPPET_MAX_BYTES);
});

test("wrap embeds escaped spec and is recoverable", () => {
  const s = goodSpec();
  s.callstack.steps[0].snippet = 'x = "</script><script>alert(1)</script>"';
  const html = wrapArtifact(s, s.title);
  assert.ok(
    html.includes("\\u003c/script>") || html.includes("\\u003cscript>"),
    "< was escaped",
  );
  const m = html.match(
    /<script type="application\/json" id="glimpse-spec">(.*?)<\/script>/s,
  );
  assert.ok(m, "spec script tag present");
  const recovered = JSON.parse(m[1]);
  assert.strictEqual(recovered.title, s.title);
  assert.ok(recovered.callstack.steps[0].snippet.endsWith('"'));
});

test("wrap has readable fallback body for pagetext", () => {
  const s = goodSpec();
  const html = wrapArtifact(s, s.title);
  assert.ok(html.includes('id="glimpse-fallback"'));
  const afterScripts = html.replace(/<script.*?<\/script>/gs, " ");
  assert.ok(afterScripts.includes("daemon"));
});

test("wrap marks artifact kind", () => {
  const html = wrapArtifact(goodSpec(), "t");
  assert.ok(html.includes('id="glimpse-explain"'));
});

test("wrap escapes agent controlled fallback fields", () => {
  const s = goodSpec();
  s.title = "<script>alert(1)</script>";
  s.architecture.components[0].name = "<script>alert(1)</script>";
  const html = wrapArtifact(s, s.title);
  const fallback = html
    .split('id="glimpse-fallback"')[1]
    .split("</body>")[0];
  assert.ok(fallback.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!fallback.includes("<script>alert(1)</script>"));
});

test("wrap escapes u2028 in script block and round trips", () => {
  const s = goodSpec();
  s.callstack.steps[0].snippet = "a b c";
  const html = wrapArtifact(s, s.title);
  const region = html.split('id="glimpse-spec">')[1].split("</script>")[0];
  assert.ok(!region.includes(" "));
  assert.ok(!region.includes(" "));
  assert.ok(region.includes("\\u2028") && region.includes("\\u2029"));
  const recovered = JSON.parse(region);
  assert.strictEqual(recovered.callstack.steps[0].snippet, "a b c");
});

function run(args, stdin) {
  return spawnSync("node", [MODULE, ...args], { input: stdin, encoding: "utf8" });
}

test("cli validate ok", () => {
  const r = run(["validate"], JSON.stringify(goodSpec()));
  assert.strictEqual(r.status, 0, r.stderr);
});

test("cli validate rejects with message", () => {
  const bad = goodSpec();
  delete bad.title;
  const r = run(["validate"], JSON.stringify(bad));
  assert.notStrictEqual(r.status, 0);
  assert.ok(r.stderr.includes("title is required"));
});

test("cli wrap emits html", () => {
  const r = run(["wrap", "My Title"], JSON.stringify(goodSpec()));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('id="glimpse-spec"'));
});

test("cli non list collection exits 2 with message", () => {
  const r = run(
    ["validate"],
    '{"scope":"change","title":"t","dataflow":{"nodes":5}}',
  );
  assert.strictEqual(r.status, 2, r.stderr);
  assert.ok(r.stderr.includes("must be a list"));
  assert.ok(!r.stderr.includes("Traceback"));
  assert.ok(!r.stderr.includes("\n    at "), "no node stack frames");
});
