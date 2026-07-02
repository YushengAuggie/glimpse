// Regression test for the bridge's canvas-origin matcher (bin/glimpse).
//
// The bug: the bridge matched canvas tabs by an EXACT origin
// ("http://127.0.0.1:PORT"), so a tab opened at http://localhost:PORT — the same
// loopback server — got no liveness stamp and no question capture. The agent
// looked "offline" and everything typed into it silently vanished.
//
// This reads the real `isCanvasOrigin` predicate out of bin/glimpse (it lives in
// a bash heredoc, so it can't be imported) and asserts it accepts every loopback
// alias on the right port while staying anchored against look-alike hosts.
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "bin", "glimpse"), "utf8");

// Pull the exact source lines out of the shipped script so the test exercises the
// real predicate, not a copy — if someone reverts to `=== expectedOrigin`, the
// extraction still succeeds but the loopback-alias assertions below fail.
function extract(re, label) {
  const m = SRC.match(re);
  if (!m) throw new Error("could not find " + label + " in bin/glimpse");
  return m[0];
}
const hostsLine = extract(/const LOOPBACK_HOSTS=new Set\(\[.*\]\);/, "LOOPBACK_HOSTS");
const predLine = extract(/const isCanvasOrigin=[^\n]*;/, "isCanvasOrigin");

const PORT = "4321";
const isCanvasOrigin = new Function("PORT", `${hostsLine}\n${predLine}\nreturn isCanvasOrigin;`)(PORT);

test("accepts every loopback alias on the canvas port", () => {
  for (const u of [
    "http://127.0.0.1:4321/#mianjing",
    "http://localhost:4321/#harvey-coding",
    "http://[::1]:4321/",
    "http://127.0.0.1:4321",
  ]) {
    assert.strictEqual(isCanvasOrigin(u), true, "should accept " + u);
  }
});

test("rejects wrong port, wrong scheme, and look-alike hosts (anchored)", () => {
  for (const u of [
    "http://localhost:9999/",          // wrong port
    "https://127.0.0.1:4321/",         // wrong scheme
    "http://evil.localhost:4321/",     // subdomain of localhost — not loopback
    "http://127.0.0.1.evil.com:4321/", // prefix look-alike
    "http://localhost.evil.com:4321/", // suffix look-alike
    "file:///tmp/x.html",
    "about:blank",
  ]) {
    assert.strictEqual(isCanvasOrigin(u), false, "should reject " + u);
  }
});
