// Unit test for `glimpse read` (lib/glimpse-read.mjs).
//
// Like glimpse-snapshot.mjs, the read body is not an importable module — run_cdp
// splices it after the CDP helper and runs it as statements inside an async IIFE,
// so cdpConnect / cdpConnectApp / fail / console are ambient. This test reproduces
// that shape: it reads the shipped body, wraps it in `async () => { … }`, and
// injects a STUB cdpConnectApp whose `send` returns a canned document identity and
// whose `on` replays canned Runtime.consoleAPICalled / Runtime.exceptionThrown
// events. That exercises the real console/error accumulation, the text cap, the
// JSON shape, and secret scrubbing end to end — with no browser.
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY = readFileSync(join(HERE, "..", "lib", "glimpse-read.mjs"), "utf8");

// Drive the real body. `events` maps a CDP method to the params replayed to every
// on() subscriber for that method the moment it subscribes; `doc` is the object the
// page's Runtime.evaluate returns.
async function runRead({ doc, events = {}, url = "" }) {
  const lines = [];
  const stubConsole = { log: (s) => lines.push(String(s)) };
  const send = async (method) => {
    if (method === "Runtime.evaluate") return { result: { value: JSON.stringify(doc) } };
    return {};
  };
  // Replay canned events synchronously at subscribe time — the body subscribes
  // before it navigates, so the ordering matches a real load.
  const on = (method, handler) => {
    for (const p of events[method] || []) handler(p);
    return () => {};
  };
  const chan = { send, waitEvent: async () => ({}), on, close: () => {} };
  const cdpConnectApp = async () => chan;
  const cdpConnect = async () => chan;
  const fail = (e) => { throw e; };

  const prevUrl = process.env.URL;
  process.env.URL = url;
  try {
    const run = new Function("cdpConnect", "cdpConnectApp", "fail", "console",
      `return (async () => {\n${BODY}\n})();`);
    await run(cdpConnect, cdpConnectApp, fail, stubConsole);
  } finally {
    if (prevUrl === undefined) delete process.env.URL; else process.env.URL = prevUrl;
  }
  return JSON.parse(lines.join("\n"));
}

const prevSecret = process.env.SECRET_PATTERN;
test.before(() => { process.env.SECRET_PATTERN = "sk-[A-Za-z0-9_-]{20,}"; });
test.after(() => {
  if (prevSecret === undefined) delete process.env.SECRET_PATTERN; else process.env.SECRET_PATTERN = prevSecret;
});

test("reports identity + visible text of the page", async () => {
  const out = await runRead({ doc: { title: "Live App", url: "http://127.0.0.1:8899/", text: "Hello world" } });
  assert.equal(out.title, "Live App");
  assert.equal(out.url, "http://127.0.0.1:8899/");
  assert.equal(out.text, "Hello world");
  assert.deepEqual(out.console, []);
  assert.deepEqual(out.errors, []);
});

test("captures console output and uncaught errors emitted during load", async () => {
  const out = await runRead({
    doc: { title: "T", url: "u", text: "x" },
    events: {
      "Runtime.consoleAPICalled": [
        { type: "log", args: [{ value: "app booted" }] },
        { type: "warning", args: [{ value: "careful" }, { value: 42 }] },
      ],
      "Runtime.exceptionThrown": [
        { exceptionDetails: { exception: { description: "TypeError: boom" } } },
      ],
    },
  });
  assert.deepEqual(out.console, [
    { type: "log", text: "app booted" },
    { type: "warning", text: "careful 42" },
  ]);
  assert.deepEqual(out.errors, ["TypeError: boom"]);
});

test("scrubs secrets out of text and console lines", async () => {
  const out = await runRead({
    doc: { title: "T", url: "u", text: "key sk-abcdefghijklmnopqrstuvwxyz0123 in body" },
    events: {
      "Runtime.consoleAPICalled": [
        { type: "log", args: [{ value: "logged sk-abcdefghijklmnopqrstuvwxyz0123" }] },
      ],
    },
  });
  assert.doesNotMatch(out.text, /sk-abcdefghijklmnopqrstuvwxyz0123/);
  assert.match(out.text, /key \[REDACTED\] in body/);
  assert.doesNotMatch(out.console[0].text, /sk-abcdefghijklmnopqrstuvwxyz0123/);
});

test("caps the text dump at 8000 chars", async () => {
  const out = await runRead({ doc: { title: "T", url: "u", text: "a".repeat(9000) } });
  assert.equal(out.text.length, 8000);
});
