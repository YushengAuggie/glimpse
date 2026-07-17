#!/usr/bin/env node
// glimpse-audit-report.mjs — turn a captured layout audit into human output.
// Node stdlib only. Ported from the former glimpse_audit_report.py.
//
// The auditor (canvas/glimpse-audit.js) runs in the artifact iframe and posts
// findings up to the canvas shell, where they land as `window.__glimpse_audit`.
// `bin/glimpse`'s `_audit_capture` reads that object over CDP and pipes the raw
// JSON here so both the standalone `glimpse audit` verb and auto-audit-on-publish
// share ONE renderer.
//
// Input : the audit JSON object on stdin (or empty / "null" when the auditor never
//         reported). Env: MODE = "full" | "brief"; SLUG (fallback slug).
// Output: the report on stdout. `brief` prints NOTHING when the artifact is clean.
// Exit  : 2 when any error-severity finding is present, else 0.
//
// Severity/finding vocabulary is owned by glimpse-audit.js; this module only
// formats and counts, so audit rules stay in one place.

import fs from "node:fs";

// kind → friendlier phrase for the one-line publish summary. Unknown kinds fall
// back to the raw kind so a new rule in glimpse-audit.js still reads sensibly.
const PHRASE = {
  "page-horizontal-overflow": "horizontal overflow",
  "element-overflow": "content overflow",
  "clipped-text": "clipped text",
  "overlapping-text": "overlapping text",
  "invisible-text": "text nearly invisible",
};
const BRIEF_LIST = 3; // findings named inline in the brief line before "+N more"

function load(raw) {
  raw = (raw || "").trim();
  if (!raw || raw === "null") return null;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
}

function findingsOf(audit) {
  const f = audit.findings;
  return Array.isArray(f)
    ? f.filter((x) => x && typeof x === "object" && !Array.isArray(x))
    : [];
}

function split(findings) {
  const err = findings.filter((x) => x.severity === "error");
  const warn = findings.filter((x) => x.severity !== "error");
  return [err, warn];
}

// Compact metric suffix for a finding: pixels for overflow/overlap kinds, a
// contrast ratio for invisible-text. Kept generic so a new rule's own metric
// still reads sensibly.
function px(x) {
  if (x.overflowPx) return `  (+${x.overflowPx}px)`;
  if (x.ratio != null) return `  (${x.ratio}:1)`;
  return "";
}

function full(audit, slug) {
  const findings = findingsOf(audit);
  const [err, warn] = split(findings);
  const vw = audit.viewportWidth;
  const lines = [
    `glimpse audit ${slug} @ ${vw}px viewport — ${err.length} error, ${warn.length} warning`,
  ];
  for (const x of findings) {
    lines.push(`  [${x.severity}] ${x.kind}  ${x.selector}${px(x)}`);
  }
  // compact machine line (same keys/order the verb has always emitted).
  lines.push(
    JSON.stringify({
      slug,
      viewportWidth: vw,
      errors: err.length,
      warnings: warn.length,
      findings,
    }),
  );
  return [lines.join("\n"), err.length ? 2 : 0];
}

function brief(audit, slug) {
  const findings = findingsOf(audit);
  if (!findings.length) return ["", 0]; // clean artifact → stay silent
  const [err] = split(findings);
  const named = [];
  for (const x of findings.slice(0, BRIEF_LIST)) {
    const phrase = PHRASE[x.kind] || x.kind;
    named.push(`${phrase} in ${x.selector}${px(x)}`);
  }
  const more = findings.length - BRIEF_LIST;
  if (more > 0) named.push(`+${more} more`);
  const n = findings.length;
  const line = `⚠ glimpse: ${n} layout issue${n === 1 ? "" : "s"} in ${slug} — ${named.join("; ")} — run: glimpse audit ${slug}`;
  return [line, err.length ? 2 : 0];
}

function main() {
  const mode = process.env.MODE || "full";
  let slug = process.env.SLUG || "";
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  const audit = load(raw);
  if (audit === null) {
    // No audit reported. `full` callers print their own "no audit" note before
    // invoking us, so emit nothing and succeed either way.
    return 0;
  }
  if (!slug) slug = audit.slug || "";
  const [out, code] = mode === "brief" ? brief(audit, slug) : full(audit, slug);
  if (out) process.stdout.write(out + "\n");
  return code;
}

process.exit(main());
