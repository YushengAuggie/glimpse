// Covers the canvas Export/Share action channel wired through the bridge
// (lib/glimpse-bridge.mjs) — see canvas/index.html's startAction / __glimpseActionResult.
//
// The bridge runs as an ES module spliced after the CDP helper, so importing it would
// start the poll loop. Instead we extract the pure parse helpers verbatim (the same
// technique as tests/test_bridge_origin.mjs) and assert they turn the REAL stdout of
// `glimpse export` / `glimpse share` into the structured result the shell renders.
// We also assert the drain-loop recognizes {type:"glimpse:action"} and that `poll`
// skips it (so a UI action never gets persisted as a bogus user turn).
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = readFileSync(join(HERE, "..", "lib", "glimpse-bridge.mjs"), "utf8");
const POLL = readFileSync(join(HERE, "..", "lib", "glimpse-poll.mjs"), "utf8");

// Pull the marked pure-helper block out of the shipped source and eval it, so the
// test exercises the real regexes rather than a copy.
function extractBlock(src, startMark, endMark) {
  const a = src.indexOf(startMark), b = src.indexOf(endMark);
  if (a < 0 || b < 0) throw new Error("could not find " + startMark + " block");
  return src.slice(a, b);
}
const helperSrc = extractBlock(
  BRIDGE,
  "// >>> glimpse-action parse helpers",
  "// <<< glimpse-action parse helpers"
);
const { parseExportPath, parseShareResult } = new Function(
  helperSrc + "\nreturn { parseExportPath, parseShareResult };"
)();

test("parseExportPath pulls the file path out of `glimpse export` stdout", () => {
  const out = "exported → /home/u/proj/arch.export.html  (open it in any browser; no glimpse server needed)\n";
  assert.strictEqual(parseExportPath(out), "/home/u/proj/arch.export.html");
});

test("parseExportPath tolerates a path with no trailing hint", () => {
  assert.strictEqual(parseExportPath("exported → /tmp/x.html"), "/tmp/x.html");
});

test("parseShareResult pulls url + generated password out of `glimpse share` stdout", () => {
  const out = [
    "shared → https://ht-ml.app/s/abc123",
    "  visibility: PRIVATE — viewers must enter this password:",
    "  password:   s3cr3t-token   (generated — save it; the page cannot be viewed without it)",
    "  update key: uk_xyz   (secret — keep it to update or manage the page later)",
  ].join("\n");
  const r = parseShareResult(out);
  assert.strictEqual(r.url, "https://ht-ml.app/s/abc123");
  assert.strictEqual(r.password, "s3cr3t-token");
});

test("parseShareResult leaves password empty for a public page", () => {
  const out = "shared → https://ht-ml.app/s/pub\n  visibility: PUBLIC — anyone with the link can view\n";
  const r = parseShareResult(out);
  assert.strictEqual(r.url, "https://ht-ml.app/s/pub");
  assert.strictEqual(r.password, "");
});

test("the bridge drain loop routes glimpse:action to runAction, not the question path", () => {
  // The action branch must sit before persistUser and hand off to runAction + deliver.
  assert.match(BRIDGE, /if\(m\.type==="glimpse:action"\)\{[\s\S]*?runAction\(m\)[\s\S]*?deliverActionResult\(c, res\)/);
  // runAction runs the REAL verbs (no reimplementation) and stays private-by-default.
  assert.match(BRIDGE, /execFileSync\("bash",\[BIN,"export",slug\]/);
  assert.match(BRIDGE, /execFileSync\("bash",\[BIN,"share",slug\]/);
  // The result is pushed back over the same CDP connection via a shell-side hook.
  assert.match(BRIDGE, /window\.__glimpseActionResult&&window\.__glimpseActionResult\(/);
});

test("poll skips glimpse:action so a UI action is never persisted as a user turn", () => {
  assert.match(POLL, /if \(m\.type === "glimpse:action"\) continue;/);
  // The skip must come before persistUser in the drain loop.
  const skipAt = POLL.indexOf('m.type === "glimpse:action"');
  const persistAt = POLL.indexOf("persistUser(m)", skipAt);
  assert.ok(skipAt > 0 && persistAt > skipAt, "skip precedes persistUser");
});
