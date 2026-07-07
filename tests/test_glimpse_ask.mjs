// Port of tests/test_glimpse_ask.py to node:test, exercising lib/glimpse-ask.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { validate, wrapArtifact, SpecError } from "../lib/glimpse-ask.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(__dirname, "..", "lib", "glimpse-ask.mjs");

function goodSpec() {
  return {
    prompt: "Approve the migration plan?",
    intro: "Dual-write for a week, then cut reads over.",
    fields: [
      {
        type: "radio",
        name: "decision",
        label: "Decision",
        required: true,
        options: [
          { value: "approve", label: "Approve", selected: true },
          { value: "reject", label: "Reject" },
        ],
      },
      {
        type: "checkbox",
        name: "safeguards",
        options: [
          { value: "backup", label: "Snapshot first" },
          { value: "offpeak", label: "Run off-peak" },
        ],
      },
      {
        type: "select",
        name: "batch",
        required: true,
        options: [
          { value: "500", label: "500" },
          { value: "1000", label: "1,000" },
        ],
      },
      { type: "text", name: "note", placeholder: "e.g. run after 6pm" },
      { type: "textarea", name: "details" },
    ],
  };
}

function countOccurrences(hay, needle) {
  return hay.split(needle).length - 1;
}

test("validate accepts good spec", () => {
  assert.strictEqual(validate(goodSpec()), true);
});

const rejectCases = [
  { mutate: (s) => delete s.fields, msg: "fields must be a non-empty list" },
  { mutate: (s) => (s.fields = []), msg: "fields must be a non-empty list" },
  {
    mutate: (s) => (s.fields[0] = { type: "radio", name: "x" }),
    msg: "options must be a non-empty list",
  },
  {
    mutate: (s) =>
      (s.fields[0] = { type: "nope", name: "x", options: [{ value: "a" }] }),
    msg: "type must be one of",
  },
  {
    mutate: (s) => (s.fields[0] = { type: "text", name: "a b" }),
    msg: "must match",
  },
  {
    mutate: (s) => s.fields.push({ type: "text", name: "note" }),
    msg: "duplicate field name",
  },
  {
    mutate: (s) =>
      (s.fields[3] = { type: "text", name: "note", options: [{ value: "a" }] }),
    msg: "options not allowed",
  },
  {
    mutate: (s) => s.fields[0].options.push({ value: "approve" }),
    msg: "duplicate option value",
  },
  {
    mutate: (s) => s.fields[0].options.push({ label: "no value" }),
    msg: "value must be a non-empty string",
  },
];

for (const [i, { mutate, msg }] of rejectCases.entries()) {
  test(`validate rejects case ${i}: ${msg}`, () => {
    const spec = goodSpec();
    mutate(spec);
    let err;
    assert.throws(
      () => validate(spec),
      (e) => {
        err = e;
        return e instanceof SpecError;
      },
    );
    assert.ok(
      err.message.includes(msg),
      `expected message to include ${JSON.stringify(msg)}, got ${JSON.stringify(err.message)}`,
    );
  });
}

test("wrap has accessible themed controls", () => {
  const html = wrapArtifact(goodSpec(), "Approve?");
  assert.ok(html.includes("appearance:none"));
  assert.ok(html.includes("prefers-color-scheme: dark"));
  assert.ok(html.includes('name="color-scheme" content="light dark"'));
  assert.strictEqual((html.match(/type="radio"/g) || []).length, 2);
  assert.strictEqual((html.match(/type="checkbox"/g) || []).length, 2);
  assert.ok(html.includes("<select") && html.includes("<textarea"));
  assert.ok(html.includes("glimpseRespond"));
  assert.ok(html.includes('type: "glimpse:response"'));
});

test("wrap wires required semantics", () => {
  const html = wrapArtifact(goodSpec(), "T");
  assert.ok(html.includes("<input required"));
  assert.ok(html.includes('value="" disabled selected'));
  const spec = goodSpec();
  spec.fields[1].required = true;
  assert.ok(wrapArtifact(spec, "T").includes('data-min="1"'));
});

test("wrap escapes html in labels", () => {
  const spec = goodSpec();
  spec.fields[0].options[0].label = "</script><img src=x onerror=alert(1)>";
  spec.prompt = "<b>hi</b>";
  const html = wrapArtifact(spec, "<title>");
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x"));
  const bodyBeforeScript = html.slice(0, html.lastIndexOf("<script>"));
  assert.ok(!bodyBeforeScript.includes("</script>"));
});

function run(subcmd, specText) {
  const p = spawnSync("node", [MODULE, subcmd], {
    input: specText,
    encoding: "utf8",
  });
  return { rc: p.status, out: p.stdout, err: p.stderr };
}

test("cli exit codes", () => {
  let r = run("wrap", JSON.stringify(goodSpec()));
  assert.strictEqual(r.rc, 0);
  assert.ok(r.out.includes("<!doctype html>"));

  r = run("validate", JSON.stringify({ fields: [] }));
  assert.strictEqual(r.rc, 2);
  assert.ok(r.err.includes("non-empty list"));

  r = run("validate", "not json");
  assert.strictEqual(r.rc, 2);
  assert.ok(r.err.includes("not valid JSON"));
});
