// Unit tests for `glimpse poll` (lib/glimpse-poll.mjs):
//   1. the pure compact/JSON format helpers (escaping, anchor tokens, records), and
//   2. an anti-drift guard: poll's canvas-origin predicate must be byte-identical to
//      the bridge's, since both gate which loopback tabs are trusted.
//
// poll.mjs runs as a spliced `node -e` module (imported → would start the poll loop),
// so — like tests/test_bridge_origin.mjs — we extract the source we want and eval it
// in isolation rather than importing the file.
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLL = readFileSync(join(HERE, "..", "lib", "glimpse-poll.mjs"), "utf8");
const BRIDGE = readFileSync(join(HERE, "..", "lib", "glimpse-bridge.mjs"), "utf8");

// --- pull the pure format block out of poll.mjs and eval it ------------------
function formatHelpers() {
  const m = POLL.match(/\/\/ >>> glimpse-poll format helpers[\s\S]*?\/\/ <<< glimpse-poll format helpers/);
  if (!m) throw new Error("could not find the format-helpers block in lib/glimpse-poll.mjs");
  // Expose the helpers the tests exercise.
  return new Function(
    m[0] +
    "\nreturn { esc, anchorToken, toItem, fmtCompactHeader, fmtCompactRow, fmtCompactTimeout, jsonPayload, FMT_FIELDS };"
  )();
}
const H = formatHelpers();

test("esc keeps records single-line and unambiguous", () => {
  assert.strictEqual(H.esc("a\tb"), "a\\tb");
  assert.strictEqual(H.esc("a\nb"), "a\\nb");
  assert.strictEqual(H.esc("a\r\nb"), "a\\r\\nb");
  assert.strictEqual(H.esc("a\\b"), "a\\\\b");
  assert.strictEqual(H.esc(null), "");
  assert.strictEqual(H.esc(undefined), "");
});

test("anchorToken collapses each anchor kind to a compact token", () => {
  assert.strictEqual(H.anchorToken(null), "-");
  assert.strictEqual(H.anchorToken({}), "-");
  assert.strictEqual(H.anchorToken({ exact: "foo", occurrence: 2 }), "text:2");
  assert.strictEqual(H.anchorToken({ exact: "foo" }), "text:0");
  assert.strictEqual(H.anchorToken({ kind: "node", id: "step-3" }), "node:step-3");
});

test("compact header declares the field order once", () => {
  assert.strictEqual(H.fmtCompactHeader(), "#glimpse-poll v1 fields=kind,thread,id,ts,anchor,quote,text");
  assert.deepStrictEqual(H.FMT_FIELDS, ["kind", "thread", "id", "ts", "anchor", "quote", "text"]);
});

test("a compact row is TAB-separated in field order with a text anchor token", () => {
  const it = H.toItem({
    type: "question", slug: "arch", id: "1-2-ab", ts: 1751,
    anchor: { exact: "cache", occurrence: 1 }, quote: "the cache", text: "why write-through?",
  });
  const row = H.fmtCompactRow(it);
  assert.deepStrictEqual(row.split("\t"), ["question", "arch", "1-2-ab", "1751", "text:1", "the cache", "why write-through?"]);
});

test("newlines in text stay inside one record", () => {
  const it = H.toItem({ type: "question", slug: "s", id: "i", ts: 1, text: "line1\nline2" });
  const row = H.fmtCompactRow(it);
  assert.strictEqual(row.split("\n").length, 1, "row must be exactly one line");
  assert.ok(row.endsWith("line1\\nline2"));
});

test("--json payload is one valid JSON object with full anchor + count", () => {
  const items = [H.toItem({ type: "question", slug: "s", id: "i", ts: 9, anchor: { kind: "node", id: "n1", label: "cmd()" }, text: "?" })];
  const parsed = JSON.parse(H.jsonPayload(items, null, 123));
  assert.strictEqual(parsed.type, "poll");
  assert.strictEqual(parsed.count, 1);
  assert.strictEqual(parsed.ts, 123);
  assert.strictEqual(parsed.items[0].anchor.label, "cmd()", "--json keeps the full anchor object");
  assert.ok(!("timeout" in parsed), "no timeout key when delivering");
});

test("--json timeout payload carries the elapsed seconds and empty items", () => {
  const parsed = JSON.parse(H.jsonPayload([], 30, 5));
  assert.strictEqual(parsed.count, 0);
  assert.strictEqual(parsed.timeout, 30);
  assert.deepStrictEqual(parsed.items, []);
});

test("compact timeout marker is a comment line", () => {
  assert.strictEqual(H.fmtCompactTimeout(12), "#glimpse-poll v1 timeout=12s");
});

// --- anti-drift: poll's origin predicate must equal the bridge's -------------
function extract(src, re, label, where) {
  const m = src.match(re);
  if (!m) throw new Error("could not find " + label + " in " + where);
  return m[0];
}
test("poll and bridge share a byte-identical canvas-origin predicate", () => {
  const hostsRe = /const LOOPBACK_HOSTS=new Set\(\[.*\]\);/;
  const predRe = /const isCanvasOrigin=[^\n]*;/;
  assert.strictEqual(
    extract(POLL, hostsRe, "LOOPBACK_HOSTS", "glimpse-poll.mjs"),
    extract(BRIDGE, hostsRe, "LOOPBACK_HOSTS", "glimpse-bridge.mjs"),
    "LOOPBACK_HOSTS drifted between poll and bridge"
  );
  assert.strictEqual(
    extract(POLL, predRe, "isCanvasOrigin", "glimpse-poll.mjs"),
    extract(BRIDGE, predRe, "isCanvasOrigin", "glimpse-bridge.mjs"),
    "isCanvasOrigin drifted between poll and bridge"
  );
});

test("the shared predicate accepts loopback aliases and rejects look-alikes", () => {
  const hostsLine = extract(POLL, /const LOOPBACK_HOSTS=new Set\(\[.*\]\);/, "LOOPBACK_HOSTS", "glimpse-poll.mjs");
  const predLine = extract(POLL, /const isCanvasOrigin=[^\n]*;/, "isCanvasOrigin", "glimpse-poll.mjs");
  const isCanvasOrigin = new Function("PORT", `${hostsLine}\n${predLine}\nreturn isCanvasOrigin;`)("4321");
  for (const u of ["http://127.0.0.1:4321/#x", "http://localhost:4321/", "http://[::1]:4321/"])
    assert.strictEqual(isCanvasOrigin(u), true, "accept " + u);
  for (const u of ["http://127.0.0.1.evil.com:4321/", "http://evil.localhost:4321/", "https://127.0.0.1:4321/", "http://localhost:9999/"])
    assert.strictEqual(isCanvasOrigin(u), false, "reject " + u);
});
