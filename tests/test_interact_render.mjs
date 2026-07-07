// Unit test for `glimpse click / scroll / wait` (lib/glimpse-interact.mjs).
//
// Same shape as the snapshot/read tests: the body runs as statements inside
// run_cdp's IIFE, so cdpConnectApp / fail / console are ambient. This test injects a
// STUB cdpConnectApp whose `send` echoes back whatever the page expression would
// return (parsed from the Runtime.evaluate expression's canned map), exercising the
// action dispatch, JSON output shape, and secret scrubbing without a browser.
//
// The body calls process.exit(2) on a failed action, which would kill the test
// runner — so these cases only drive SUCCESSFUL actions (ok:true), which never exit.
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY = readFileSync(join(HERE, "..", "lib", "glimpse-interact.mjs"), "utf8");

// Drive the real body with a stubbed channel. `evalResult(expr)` returns the value
// the page would produce for a given Runtime.evaluate expression.
async function runInteract({ env, evalResult }) {
  const lines = [];
  const stubConsole = { log: (s) => lines.push(String(s)), error: () => {} };
  const send = async (method, params = {}) => {
    if (method === "Runtime.evaluate") return { result: { value: evalResult(params.expression) } };
    return {};
  };
  const chan = { send, waitEvent: async () => ({}), on: () => () => {}, close: () => {} };
  const cdpConnectApp = async () => chan;
  const fail = (e) => { throw e; };

  const saved = {};
  for (const k of ["ACTION", "SELECTOR", "TEXT", "SCROLL_TO", "SCROLL_BY", "TIMEOUT_MS"]) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
  try {
    const run = new Function("cdpConnectApp", "fail", "console", `return (async () => {\n${BODY}\n})();`);
    await run(cdpConnectApp, fail, stubConsole);
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
  return JSON.parse(lines.join("\n"));
}

const prevSecret = process.env.SECRET_PATTERN;
test.before(() => { process.env.SECRET_PATTERN = "sk-[A-Za-z0-9_-]{20,}"; });
test.after(() => {
  if (prevSecret === undefined) delete process.env.SECRET_PATTERN; else process.env.SECRET_PATTERN = prevSecret;
});

test("click returns a structured ok result", async () => {
  const out = await runInteract({
    env: { ACTION: "click", SELECTOR: "#go" },
    evalResult: () => ({ ok: true, action: "click", selector: "#go", tag: "button", text: "Submit" }),
  });
  assert.deepEqual(out, { ok: true, action: "click", selector: "#go", tag: "button", text: "Submit" });
});

test("click scrubs secrets out of captured element text", async () => {
  const out = await runInteract({
    env: { ACTION: "click", SELECTOR: "#go" },
    evalResult: () => ({ ok: true, action: "click", selector: "#go", tag: "button", text: "token sk-abcdefghijklmnopqrstuvwxyz0123" }),
  });
  assert.doesNotMatch(out.text, /sk-abcdefghijklmnopqrstuvwxyz0123/);
  assert.match(out.text, /token \[REDACTED\]/);
});

test("scroll --to reports the new scrollY", async () => {
  const out = await runInteract({
    env: { ACTION: "scroll", SCROLL_TO: "800" },
    // the body builds a window.scrollTo(...) expression; echo a matching result
    evalResult: (expr) => { assert.match(expr, /window\.scrollTo\(0,800\)/); return { ok: true, action: "scroll", to: 800, scrollY: 800 }; },
  });
  assert.equal(out.scrollY, 800);
  assert.equal(out.to, 800);
});

test("scroll into a selector uses scrollIntoView", async () => {
  const out = await runInteract({
    env: { ACTION: "scroll", SELECTOR: "#foot" },
    evalResult: (expr) => { assert.match(expr, /scrollIntoView/); return { ok: true, action: "scroll", into: "#foot", scrollY: 958 }; },
  });
  assert.equal(out.into, "#foot");
});

test("wait resolves ok once the probe is truthy", async () => {
  const out = await runInteract({
    env: { ACTION: "wait", SELECTOR: "#ready", TIMEOUT_MS: "2000" },
    evalResult: () => true,
  });
  assert.deepEqual(out, { ok: true, action: "wait", for: "#ready" });
});
