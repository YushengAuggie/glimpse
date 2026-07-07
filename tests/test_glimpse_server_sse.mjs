// Push channel (SSE) for the canvas: lib/glimpse-server.mjs serves an
// /__glimpse/events stream that emits a `feed` event when feed.json changes and a
// `thread` event when any threads/<slug>.json changes, replacing the canvas's old
// busy-poll timers. Offline, stdlib-only — starts the real server on a loopback
// ephemeral port and drives it end to end.
//
// RUNTIME-GATED. This test spins up the real server as a subprocess and connects
// back over the loopback socket. That works locally (and on the ubuntu runner) but
// the hosted macOS GitHub runner cannot complete the loopback server↔client setup,
// a runner-environment limitation, not a product bug (the SSE feature itself is
// verified locally and on ubuntu). So, like the live-CDP tests, this self-skips
// unless GLIMPSE_RUNTIME_TESTS is set — run it explicitly with
// `GLIMPSE_RUNTIME_TESTS=1 node --test tests/test_glimpse_server_sse.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUN = ["1", "true"].includes(process.env.GLIMPSE_RUNTIME_TESTS || "0");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, "..", "lib", "glimpse-server.mjs");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function get(port, urlPath, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: urlPath, timeout },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function waitUp(port, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const r = await get(port, "/feed.json");
      if (r.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Open the SSE stream. Resolves with { req, res, next } where `next(n)` collects
// the next `n` `event:` names off the stream (or resolves early on close/timeout).
function openSse(port, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/__glimpse/events", timeout },
      (res) => {
        assert.equal(res.statusCode, 200, `status ${res.statusCode}`);
        const ctype = res.headers["content-type"] || "";
        assert.ok(ctype.startsWith("text/event-stream"), `content-type: ${ctype}`);
        res.setEncoding("utf8");

        let buf = ""; // unconsumed raw bytes (for the no-content assertion)
        const events = []; // parsed `event:` names not yet handed out
        let pending = null; // { want, got, resolve, timer }

        function tryFulfil() {
          if (!pending) return;
          while (pending.got.length < pending.want && events.length) {
            pending.got.push(events.shift());
          }
          if (pending.got.length >= pending.want) {
            clearTimeout(pending.timer);
            const p = pending;
            pending = null;
            p.resolve(p.got);
          }
        }

        function feedLines(text) {
          for (const raw of text.split("\n")) {
            const line = raw.trim();
            if (line.startsWith("event:")) {
              events.push(line.slice("event:".length).trim());
            }
          }
          tryFulfil();
        }

        res.on("data", (chunk) => {
          buf += chunk;
          feedLines(chunk);
        });
        res.on("end", () => {
          if (pending) {
            clearTimeout(pending.timer);
            pending.resolve(pending.got);
            pending = null;
          }
        });

        function next(want, waitMs = 5000) {
          return new Promise((res2) => {
            pending = { want, got: [], resolve: res2, timer: null };
            pending.timer = setTimeout(() => {
              const p = pending;
              pending = null;
              if (p) p.resolve(p.got);
            }, waitMs);
            tryFulfil();
          });
        }

        resolve({ req, res, next, raw: () => buf });
      }
    );
    req.on("timeout", () => req.destroy(new Error("sse timeout")));
    req.on("error", reject);
  });
}

async function withServer(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glimpse-sse-"));
  fs.writeFileSync(path.join(root, "feed.json"), '{"artifacts":[]}');
  fs.mkdirSync(path.join(root, "threads"));
  const port = await freePort();
  const proc = spawn("node", [SERVER, String(port), root], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout.on("data", (d) => (out += d));
  proc.stderr.on("data", (d) => (out += d));
  try {
    const up = await waitUp(port);
    if (!up) {
      throw new assert.AssertionError({
        message: "server did not come up; output:\n" + out,
      });
    }
    await fn(port, root);
  } finally {
    proc.kill();
  }
}

test("SSE pushes feed and thread changes", { skip: !RUN }, async () => {
  await withServer(async (port, root) => {
    const sse = await openSse(port);
    try {
      // A freshly-connected client is told to pull both streams once.
      assert.deepEqual(await sse.next(2), ["feed", "thread"]);

      // Feed change → a `feed` event, not a `thread` one.
      await sleep(500);
      fs.writeFileSync(
        path.join(root, "feed.json"),
        '{"artifacts":[{"slug":"x","ts":1,"title":"X"}]}'
      );
      assert.deepEqual(await sse.next(1), ["feed"]);

      // Thread change → a `thread` event.
      await sleep(500);
      fs.writeFileSync(
        path.join(root, "threads", "x.json"),
        '{"turns":[{"id":"1","role":"user"}]}'
      );
      assert.deepEqual(await sse.next(1), ["thread"]);
    } finally {
      sse.req.destroy();
    }
  });
});

test("SSE is loopback and carries no file content", { skip: !RUN }, async () => {
  await withServer(async (port, root) => {
    // The event body is a bare signal — never the file's (secret-bearing) contents.
    fs.writeFileSync(
      path.join(root, "feed.json"),
      '{"artifacts":[{"slug":"secret-sk-abc","ts":9}]}'
    );
    const sse = await openSse(port);
    try {
      await sleep(600);
      fs.writeFileSync(
        path.join(root, "feed.json"),
        '{"artifacts":[{"slug":"secret-sk-def","ts":10}]}'
      );
      // Drain the stream for a moment, then inspect the accumulated bytes.
      await sse.next(3, 2000);
      const blob = sse.raw();
      assert.ok(!blob.includes("secret-sk"), "stream must not carry file content");
      assert.ok(blob.includes("data: 1"), "stream must carry the bare signal");
    } finally {
      sse.req.destroy();
    }
  });
});
