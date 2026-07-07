#!/usr/bin/env node
// glimpse-explain.mjs — code-explainer engine: validate an explain spec and wrap it
// into an artifact. Imported by tests and invoked as a CLI by `bin/glimpse`.
// Node stdlib only. Ported from the former glimpse_explain.py (behavior-preserving).

import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const SCOPES = new Set(["change", "feature", "repo"]);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MERMAID_RESERVED = new Set([
  "end",
  "default",
  "graph",
  "flowchart",
  "subgraph",
  "classDef",
  "linkStyle",
  "style",
  "click",
]);
export const SNIPPET_MAX_LINES = 200;
export const SNIPPET_MAX_BYTES = 16 * 1024;
const SPEC_MAX_BYTES = 2 * 1024 * 1024;

export class SpecError extends Error {}

// Python truthiness for spec view-presence checks: empty dict/array/""/0/null are
// falsy (JS treats {} and [] as truthy, so this must be explicit).
function truthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === "")
    return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

function isDict(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function pyRepr(v) {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") return "'" + v + "'";
  return String(v);
}

function checkIds(items, where) {
  if (!Array.isArray(items)) throw new SpecError(`${where} must be a list`);
  const seen = new Set();
  for (const it of items) {
    const i = isDict(it) ? it.id : undefined;
    if (typeof i !== "string" || !ID_RE.test(i))
      throw new SpecError(
        `${where}: id ${pyRepr(i)} must match [A-Za-z0-9_-]{1,64}`,
      );
    if (MERMAID_RESERVED.has(i))
      throw new SpecError(`${where}: id ${pyRepr(i)} is a reserved word`);
    if (seen.has(i)) throw new SpecError(`${where}: duplicate id ${pyRepr(i)}`);
    seen.add(i);
  }
  return seen;
}

export function validate(spec) {
  if (!isDict(spec)) throw new SpecError("spec must be a JSON object");
  if (!SCOPES.has(spec.scope))
    throw new SpecError("scope must be one of: change, feature, repo");
  if (typeof spec.title !== "string" || !spec.title.trim())
    throw new SpecError("title is required");
  if (!["architecture", "dataflow", "callstack"].some((k) => truthy(spec[k])))
    throw new SpecError(
      "at least one of architecture/dataflow/callstack must be present",
    );

  const arch = isDict(spec.architecture) ? spec.architecture : {};
  checkIds(arch.components ?? [], "architecture.components");

  const df = isDict(spec.dataflow) ? spec.dataflow : {};
  const dfIds = checkIds(df.nodes ?? [], "dataflow.nodes");
  const edges = df.edges ?? [];
  if (!Array.isArray(edges)) throw new SpecError("dataflow.edges must be a list");
  for (const e of edges) {
    if (!isDict(e)) throw new SpecError("dataflow.edges entries must be objects");
    for (const end of ["from", "to"]) {
      if (!dfIds.has(e[end]))
        throw new SpecError(
          `dataflow.edges: ${end} references unknown node ${pyRepr(e[end])}`,
        );
    }
  }

  const cs = isDict(spec.callstack) ? spec.callstack : {};
  const stepIds = checkIds(cs.steps ?? [], "callstack.steps");
  if (truthy(cs.steps)) {
    if (cs.entry === null || cs.entry === undefined)
      throw new SpecError("callstack.entry must not be null when steps are present");
    if (!stepIds.has(cs.entry))
      throw new SpecError(`callstack.entry ${pyRepr(cs.entry)} is not a declared step`);
  } else if (cs.entry !== null && cs.entry !== undefined && !stepIds.has(cs.entry)) {
    throw new SpecError(`callstack.entry ${pyRepr(cs.entry)} is not a declared step`);
  }
  for (const st of cs.steps ?? []) {
    let calls = st.calls;
    if (calls === null || calls === undefined) calls = [];
    if (!Array.isArray(calls))
      throw new SpecError(`callstack.steps[${st.id}].calls must be a list`);
    for (const c of calls) {
      if (!stepIds.has(c))
        throw new SpecError(
          `callstack.steps[${st.id}].calls references unknown step ${pyRepr(c)}`,
        );
    }
  }
  return true;
}

export function truncateSnippet(text) {
  if (typeof text !== "string") return "";
  let lines = text.split("\n");
  const total = lines.length;
  let lineCut = false;
  if (total > SNIPPET_MAX_LINES) {
    lines = lines.slice(0, SNIPPET_MAX_LINES);
    lineCut = true;
  }
  let out = lines.join("\n");
  let byteCut = false;
  if (Buffer.byteLength(out, "utf8") > SNIPPET_MAX_BYTES) {
    out = Buffer.from(out, "utf8").subarray(0, SNIPPET_MAX_BYTES).toString("utf8");
    byteCut = true;
  }
  if (byteCut) {
    // Byte cap fired (alone or after a line cut): report the lines that actually
    // survived the byte trim, not a flat 200.
    const surviving = (out.match(/\n/g) || []).length + 1;
    out += `\n// … [truncated — showing ${surviving} of ${total} lines, ${SNIPPET_MAX_BYTES / 1024 | 0} KB cap]`;
  } else if (lineCut) {
    out += `\n// … [truncated — showing ${SNIPPET_MAX_LINES} of ${total} lines]`;
  }
  return out;
}

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Make a JSON string safe inside <script>…</script>: escape every '<' as the JSON
// unicode escape <, plus U+2028/U+2029 (raw newlines to a JS parser, but legal
// inside JSON). A JSON parser decodes them back losslessly.
function escapeForScript(jsonText) {
  return jsonText
    .replace(/</g, "\\u003c")
    .replace(/ /g, "\\u2028")
    .replace(/ /g, "\\u2029");
}

function applyTruncation(spec) {
  const steps = (isDict(spec.callstack) ? spec.callstack : {}).steps ?? [];
  for (const st of steps) {
    if (isDict(st) && "snippet" in st) st.snippet = truncateSnippet(st.snippet);
  }
  return spec;
}

function readableBody(spec, title) {
  const parts = [`<div id="glimpse-fallback"><h1>${htmlEscape(title)}</h1>`];
  const arch = isDict(spec.architecture) ? spec.architecture : {};
  if (arch.summary) parts.push(`<p>${htmlEscape(arch.summary)}</p>`);
  for (const c of arch.components ?? []) {
    parts.push(
      `<p><b>${htmlEscape(c.name ?? "")}</b> — ${htmlEscape(c.role ?? "")}</p>`,
    );
    if (c.note) parts.push(`<p>${htmlEscape(c.note)}</p>`);
  }
  for (const st of (isDict(spec.callstack) ? spec.callstack : {}).steps ?? []) {
    parts.push(
      `<p><code>${htmlEscape(st.label ?? "")}</code> (${htmlEscape(st.file ?? "")})</p>`,
    );
    if (st.note) parts.push(`<p>${htmlEscape(st.note)}</p>`);
  }
  parts.push("</div>");
  return parts.join("");
}

export function wrapArtifact(spec, title) {
  spec = applyTruncation(spec);
  const payload = escapeForScript(JSON.stringify(spec));
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    // Mermaid powers the data-flow diagram. A blocking <head> script means
    // window.mermaid is defined before the renderer boots in <body>.
    '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>' +
    `<title>${htmlEscape(title)}</title></head><body>` +
    '<div id="glimpse-explain"></div>' +
    readableBody(spec, title) +
    `<script type="application/json" id="glimpse-spec">${payload}</script>` +
    "</body></html>"
  );
}

function main(argv) {
  // Exit-code contract: 2 = spec-content error (invalid JSON, oversized, or
  // SpecError) or usage error from this module; the bash verb reserves 1 for its
  // own usage/infra failures.
  if (!argv.length) {
    process.stderr.write("usage: glimpse-explain.mjs validate|wrap <title>\n");
    return 2;
  }
  const cmd = argv[0];
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch (e) {
    process.stderr.write(`glimpse explain: spec is not valid JSON: ${e.message}\n`);
    return 2;
  }
  const raw = JSON.stringify(spec);
  if (Buffer.byteLength(raw, "utf8") > SPEC_MAX_BYTES) {
    process.stderr.write(`glimpse explain: spec exceeds ${SPEC_MAX_BYTES} bytes\n`);
    return 2;
  }
  try {
    validate(spec);
  } catch (e) {
    if (e instanceof SpecError) {
      process.stderr.write(`glimpse explain: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  if (cmd === "validate") return 0;
  if (cmd === "wrap") {
    const title = argv.length > 1 ? argv[1] : spec.title ?? "Explain";
    process.stdout.write(wrapArtifact(spec, title));
    return 0;
  }
  process.stderr.write(`glimpse explain: unknown subcommand ${pyRepr(cmd)}\n`);
  return 2;
}

const isMain = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) process.exit(main(process.argv.slice(2)));
