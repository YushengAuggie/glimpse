// Source snapshot and portable page generator. No model or browser is needed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_FILE_BYTES = 1024 * 1024;
export class WalkthroughError extends Error {}
export const hash = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
export const escapeHTML = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const scriptJSON = (value) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
const fail = (message) => {
  throw new WalkthroughError(message);
};
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function text(value, name, max = 12000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail(`${name} must be nonempty text (up to ${max} characters)`);
  return value;
}
function entries(value, name, min = 1, max = 128) {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    fail(`${name} must contain ${min}–${max} entries`);
  return value;
}
function ids(items, name) {
  const seen = new Set();
  for (const item of items) {
    if (!object(item) || !ID.test(item.id)) fail(`${name} has an invalid id`);
    if (seen.has(item.id)) fail(`${name} has duplicate id ${item.id}`);
    seen.add(item.id);
  }
  return seen;
}
export function readSource(repo, relative) {
  if (
    typeof relative !== "string" ||
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.split("/").includes("..")
  )
    fail("source path must be relative and cannot escape the repository");
  const root = fs.realpathSync(repo);
  const target = fs.realpathSync(path.join(root, relative));
  if (!target.startsWith(root + path.sep))
    fail(`source path is outside repository: ${relative}`);
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
    fail(
      `source must be a file no larger than ${MAX_FILE_BYTES} bytes: ${relative}`,
    );
  const raw = fs.readFileSync(target, "utf8");
  if (raw.includes("\0")) fail(`binary source is not supported: ${relative}`);
  return { raw, hash: hash(raw) };
}
export function sourceRange(source, start, end) {
  const lines = source.raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start ||
    end > lines.length ||
    end - start > 1000
  )
    fail(`invalid source range ${start}–${end}`);
  return lines.slice(start - 1, end).join("\n");
}
function asset(name) {
  for (const dir of [path.join(here, "../canvas"), here]) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  fail(`missing walkthrough asset: ${name}; reinstall Glimpse`);
}
let tokenizer;
function highlight(raw, lang) {
  tokenizer ||= require(asset("glimpse-explain.js")).highlightTokens;
  return raw.split("\n").map((line) =>
    tokenizer(line, lang)
      .map((t) =>
        t.cls
          ? `<span class="tok-${t.cls}">${escapeHTML(t.text)}</span>`
          : escapeHTML(t.text),
      )
      .join(""),
  );
}
export function parentMap(snapshot) {
  const parents = new Map();
  for (const frame of snapshot.frames)
    for (const [child, block] of Object.entries(frame.calls)) {
      if (parents.has(child))
        fail(
          `multiple parents for ${child}; use one unambiguous scenario in v1`,
        );
      parents.set(child, { frame: frame.id, block });
    }
  for (const frame of snapshot.frames) {
    const seen = new Set([frame.id]);
    let cursor = frame.id;
    while (parents.has(cursor)) {
      cursor = parents.get(cursor).frame;
      if (seen.has(cursor))
        fail(
          `call cycle at ${cursor}; recursive scenarios need distinct call occurrences`,
        );
      seen.add(cursor);
    }
  }
  return parents;
}
export function callStack(snapshot, frameId) {
  if (!snapshot.frames.some((f) => f.id === frameId))
    fail(`unknown frame ${frameId}`);
  const parents = parentMap(snapshot),
    stack = [{ frame: frameId, block: null }];
  while (parents.has(stack[0].frame))
    stack.unshift(parents.get(stack[0].frame));
  return stack;
}
export function buildSnapshot(spec, repo) {
  if (!object(spec)) fail("walkthrough spec must be an object");
  if (Buffer.byteLength(JSON.stringify(spec)) > 2 * 1024 * 1024)
    fail("spec exceeds 2 MB");
  const stages = entries(spec.stages, "stages", 1, 12).map((s) => ({
    id: s.id,
    label: text(s.label, "stage label"),
    purpose: text(s.purpose, "stage purpose"),
  }));
  const stageIds = ids(stages, "stages");
  const inputFrames = entries(spec.frames, "frames", 1, 64),
    frameIds = ids(inputFrames, "frames"),
    files = {};
  const frames = inputFrames.map((f) => {
    const file = text(f.file, "frame file", 512);
    if (!Object.hasOwn(files, file))
      Object.defineProperty(files, file, {
        value: readSource(repo, file),
        enumerable: true,
      });
    let previousEnd = 0;
    const blocks = entries(f.blocks, "frame blocks", 2, 5).map((b, i) => {
      const raw = sourceRange(files[file], b.start, b.end);
      if (b.start <= previousEnd)
        fail(`overlapping or unordered block range in ${f.id}`);
      previousEnd = b.end;
      return {
        id: `${f.id}_b${i}`,
        title: text(b.title, "block title"),
        purpose: text(b.purpose, "block purpose"),
        start: b.start,
        end: b.end,
        raw,
        htmlLines: highlight(raw, f.lang || path.extname(file).slice(1)),
      };
    });
    const calls = f.calls ?? {};
    if (!object(calls)) fail("frame calls must map child IDs to block indexes");
    for (const [child, block] of Object.entries(calls))
      if (!frameIds.has(child) || !Number.isInteger(block) || !blocks[block])
        fail(`invalid child frame or caller block: ${f.id} → ${child}`);
    return {
      id: f.id,
      name: text(f.name, "frame name"),
      file,
      purpose: text(f.purpose, "frame purpose"),
      lang: f.lang || path.extname(file).slice(1),
      blocks,
      calls: { ...calls },
    };
  });
  parentMap({ frames });
  if (
    Object.values(files).reduce((n, f) => n + Buffer.byteLength(f.raw), 0) >
    8 * MAX_FILE_BYTES
  )
    fail("source snapshot exceeds 8 MB");
  const nodeIds = ids(entries(spec.nodes, "nodes"), "nodes");
  const nodes = spec.nodes.map((n) => {
    if (!["happy", "side", "before"].includes(n.kind))
      fail("node kind must be happy, side or before");
    if (!stageIds.has(n.stage) || !frameIds.has(n.frame))
      fail(`unknown stage or frame for ${n.id}`);
    const frame = frames.find((f) => f.id === n.frame);
    const blocks = entries(n.blocks, "active blocks", 1, 5);
    if (
      new Set(blocks).size !== blocks.length ||
      blocks.some((i) => !Number.isInteger(i) || !frame.blocks[i])
    )
      fail(`invalid active block in ${n.id}`);
    const result = {
      id: n.id,
      kind: n.kind,
      stage: n.stage,
      label: text(n.label, "node label"),
      frame: n.frame,
      blocks: [...blocks],
    };
    for (const key of ["purpose", "happens", "io", "remember"])
      result[key] = text(n[key], `node ${key}`);
    if (n.kind === "side") {
      if (!nodeIds.has(n.gate) || n.gate === n.id)
        fail(`invalid branch gate for ${n.id}`);
      result.gate = n.gate;
      result.reason = text(n.reason, "branch reason");
    }
    if (n.shape != null && !["process", "gate", "store"].includes(n.shape))
      fail(`invalid shape for ${n.id}`);
    result.shape = n.shape || "process";
    if (n.example != null) {
      if (
        !object(n.example) ||
        !["scenario", "observed", "illustrative"].includes(n.example.kind)
      )
        fail("example requires a provenance kind");
      result.example = {
        kind: n.example.kind,
        value: text(n.example.value, "example value"),
        provenance: text(n.example.provenance, "example provenance"),
      };
    }
    return result;
  });
  for (const n of nodes.filter((n) => n.kind === "side"))
    if (nodes.find((x) => x.id === n.gate).kind === "side")
      fail("side branches must attach to a main or prerequisite gate");
  const edges = entries(spec.edges ?? [], "edges", 0, 256).map((e) => {
    if (!object(e) || !nodeIds.has(e.from) || !nodeIds.has(e.to))
      fail("edge references an unknown node");
    const kind = e.kind || "data";
    if (!["data", "call", "return", "before"].includes(kind))
      fail("unknown edge kind");
    return {
      from: e.from,
      to: e.to,
      label: text(e.label, "edge data label"),
      kind,
    };
  });
  let commit = null;
  try {
    commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* hashes also cover non-Git and dirty repos */
  }
  const snapshot = {
    version: 1,
    title: text(spec.title, "title"),
    scenario: text(spec.scenario, "scenario"),
    prose_language: spec.prose_language || "en",
    basis: "source-inferred",
    commit,
    frames,
    nodes,
    edges,
    stages,
    files,
  };
  snapshot.revision = hash(JSON.stringify(snapshot));
  return snapshot;
}
export function wrapArtifact(snapshot, slug) {
  if (!ID.test(slug)) fail("invalid walkthrough slug");
  const publicSnapshot = {
    ...snapshot,
    files: Object.fromEntries(
      Object.entries(snapshot.files).map(([file, source]) => [
        file,
        { hash: source.hash },
      ]),
    ),
    slug,
  };
  if (
    process.env.SECRET_PATTERN &&
    new RegExp(process.env.SECRET_PATTERN).test(JSON.stringify(publicSnapshot))
  )
    fail(
      "selected walkthrough content contains a detected secret; choose safe source blocks before publishing",
    );
  const style = fs.readFileSync(asset("glimpse-walkthrough.css"), "utf8");
  const script = fs.readFileSync(asset("glimpse-walkthrough.js"), "utf8");
  return `<!doctype html><html lang="${escapeHTML(snapshot.prose_language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(snapshot.title)}</title><style>${style}</style></head><body><div id="walkthrough"></div><script id="walkthrough-spec" type="application/json">${scriptJSON(publicSnapshot)}</script><script>${script.replace(/<\//g, "<\\/")}</script></body></html>`;
}
