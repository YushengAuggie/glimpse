// Unit tests for lib/glimpse-audit-report.mjs — the shared renderer that both
// `glimpse audit` (full) and auto-audit-on-publish (brief) drive. Invoked as a
// subprocess so the tests also lock in the EXIT CODE the audit gate reads.
//
// Ported from tests/test_audit_report.py (byte-identical behavior).

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(__dirname, "..", "lib", "glimpse-audit-report.mjs");

function run(auditObj, mode = "full", slug = "demo") {
  const raw = auditObj === null ? "" : JSON.stringify(auditObj);
  const p = spawnSync("node", [LIB], {
    input: raw,
    env: { ...process.env, MODE: mode, SLUG: slug },
    encoding: "utf8",
  });
  return { code: p.status, out: p.stdout };
}

function audit(findings, vw = 1000) {
  return {
    slug: "demo",
    viewportWidth: vw,
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity !== "error").length,
    findings,
    ts: 123,
  };
}

const OVERFLOW = {
  selector: "div.foo",
  kind: "element-overflow",
  overflowPx: 40,
  severity: "error",
};
const CLIPPED = {
  selector: "span.bar",
  kind: "clipped-text",
  overflowPx: 570,
  severity: "error",
};
const WARN = {
  selector: "p.x",
  kind: "element-overflow",
  overflowPx: 3,
  severity: "warning",
};

// --- brief mode (publish auto-audit) ----------------------------------------

test("brief clean is silent and zero exit", () => {
  const { code, out } = run(audit([]), "brief");
  assert.equal(out, "");
  assert.equal(code, 0);
});

test("brief no audit is silent and zero exit", () => {
  // empty stdin (auditor never reported, e.g. annotate off) must not fail.
  const { code, out } = run(null, "brief");
  assert.equal(out, "");
  assert.equal(code, 0);
  // a literal "null" (window.__glimpse_audit === null) is also silent.
  const p = spawnSync("node", [LIB], {
    input: "null",
    env: { ...process.env, MODE: "brief", SLUG: "demo" },
    encoding: "utf8",
  });
  assert.equal(p.stdout, "");
  assert.equal(p.status, 0);
});

test("brief lists issues and points to audit", () => {
  const { code, out } = run(audit([OVERFLOW, CLIPPED]), "brief");
  assert.equal(code, 2); // error-severity present
  assert.ok(out.includes("2 layout issues in demo"));
  assert.ok(out.includes("content overflow in div.foo  (+40px)"));
  assert.ok(out.includes("clipped text in span.bar"));
  assert.ok(out.includes("run: glimpse audit demo"));
  assert.ok(out.startsWith("⚠"));
});

test("brief singular and truncates with more", () => {
  const many = Array.from({ length: 5 }, (_, i) => ({
    ...OVERFLOW,
    selector: `div.n${i}`,
  }));
  let { out } = run(audit(many), "brief");
  assert.ok(out.includes("5 layout issues"));
  assert.ok(out.includes("+2 more")); // 5 findings, 3 named
  ({ out } = run(audit([OVERFLOW]), "brief"));
  assert.ok(out.includes("1 layout issue in demo")); // singular, no "s"
});

test("brief warning only findings do not gate", () => {
  const { code, out } = run(audit([WARN]), "brief");
  assert.notEqual(out, ""); // still surfaced as a warning
  assert.equal(code, 0); // but no error → gate stays clean
});

// --- full mode (standalone `glimpse audit`) ---------------------------------

test("full header and finding lines", () => {
  const { code, out } = run(audit([OVERFLOW]), "full");
  const lines = out.split("\n");
  assert.equal(
    lines[0],
    "glimpse audit demo @ 1000px viewport — 1 error, 0 warning",
  );
  assert.equal(lines[1], "  [error] element-overflow  div.foo  (+40px)");
  assert.equal(code, 2);
});

test("full emits compact machine json last", () => {
  const { code, out } = run(audit([OVERFLOW, WARN]), "full");
  const lines = out.split("\n").filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  const obj = JSON.parse(last);
  assert.equal(obj.slug, "demo");
  assert.equal(obj.errors, 1);
  assert.equal(obj.warnings, 1);
  assert.equal(obj.viewportWidth, 1000);
  assert.equal(obj.findings.length, 2);
  assert.ok(!last.includes(" ")); // compact, no spaces
  assert.equal(code, 2);
});

test("full clean exits zero", () => {
  const { code, out } = run(audit([]), "full");
  const first = out.split("\n").filter((l) => l.length > 0)[0];
  assert.ok(first.endsWith("0 error, 0 warning"));
  assert.equal(code, 0);
});
