#!/usr/bin/env node
// glimpse-server.mjs — Glimpse static file server: serves the canvas, feed, and
// artifacts from the served root, bound to loopback only. Invoked as a CLI by
// `bin/glimpse`. Node stdlib only. Ported from the former glimpse_server.py
// (behavior-preserving: quiet, loopback-bound, SSE push channel).
//
//   glimpse-server.mjs <port> <root>
//
// Quiet server: no per-request access logging (the Python http.server logged every
// request and grew .server.log past 100 MB on long runs). Loopback bind — the
// canvas, feed, and artifacts are local data.
//
// Push freshness (SSE): the canvas used to busy-poll feed.json and
// threads/<slug>.json on timers. Instead, ONE watcher stats those files' mtimes
// and bumps a per-stream version; clients connected to GET /__glimpse/events are
// woken the instant either stream advances, so the browser no longer polls in the
// steady state. The event body carries only a `feed`/`thread` signal — never file
// content — so it can leak nothing the served files don't already expose.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

export const EVENTS_PATH = "/__glimpse/events";
const POLL_S = 0.4; // server-side stat cadence (cheap: stat only, no HTTP/JSON/render)
const HEARTBEAT_S = 15; // idle SSE keepalive comment → keeps the socket open + surfaces a drop

// Extension → Content-Type. Mirrors the types Python's mimetypes table resolves
// for the files the canvas serves; unknown falls back to octet-stream.
const MIME = {
  ".html": "text/html",
  ".htm": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/vnd.microsoft.icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".map": "application/json",
  ".txt": "text/plain",
  ".xml": "text/xml",
  ".wasm": "application/wasm",
};

export function contentType(p) {
  const ext = path.extname(p).toLowerCase();
  return MIME[ext] || "application/octet-stream";
}

// Resolve a URL path to a filesystem path under `root`, refusing any `..`/encoded
// escape. Returns null if it resolves outside the served root.
export function sanitizePath(root, urlPath) {
  let p = urlPath.split("?")[0].split("#")[0];
  try {
    p = decodeURIComponent(p);
  } catch {
    /* leave as-is on malformed %-escape */
  }
  let norm = path.posix.normalize(p);
  if (!norm.startsWith("/")) norm = "/" + norm; // absolute normalize clamps at root
  const base = path.resolve(root);
  const resolved = path.resolve(base, "." + norm);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

// Cheap change fingerprints. feed uses (mtime, size); threads uses (max mtime,
// file count) so a new/removed thread file registers even when mtimes collide on
// a coarse-resolution filesystem.
export function scan(root) {
  let feed = null;
  try {
    const st = fs.statSync(path.join(root, "feed.json"));
    feed = st.mtimeMs + ":" + st.size;
  } catch {
    feed = null;
  }
  let tmax = 0;
  let tcount = 0;
  try {
    for (const name of fs.readdirSync(path.join(root, "threads"))) {
      if (!name.endsWith(".json")) continue;
      tcount += 1;
      try {
        const m = fs.statSync(path.join(root, "threads", name)).mtimeMs;
        if (m > tmax) tmax = m;
      } catch {
        /* file vanished mid-scan */
      }
    }
  } catch {
    /* no threads dir yet */
  }
  return { feed, thread: tmax + ":" + tcount };
}

function serveFile(root, req, res) {
  const resolved = sanitizePath(root, req.url);
  if (resolved === null) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404");
    return;
  }
  let target = resolved;
  try {
    if (fs.statSync(target).isDirectory()) target = path.join(target, "index.html");
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404");
    return;
  }
  let body;
  try {
    body = fs.readFileSync(target);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404");
    return;
  }
  const headers = {
    "Content-Type": contentType(target),
    "Content-Length": body.length,
  };
  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(body);
}

export function start(port, root) {
  process.chdir(root);
  const ver = { feed: 0, thread: 0 };
  // Open SSE connections. Each tracks the versions it has emitted + when it last
  // wrote, so we push only advanced streams and heartbeat an idle socket.
  const clients = new Set();

  let last = scan(root); // baseline: don't bump on the first observation
  setInterval(() => {
    const cur = scan(root);
    if (cur.feed !== last.feed) ver.feed += 1;
    if (cur.thread !== last.thread) ver.thread += 1;
    last = cur;
    const now = Date.now();
    for (const c of clients) {
      let wrote = false;
      try {
        if (ver.feed !== c.seenFeed) {
          c.res.write("event: feed\ndata: 1\n\n");
          c.seenFeed = ver.feed;
          wrote = true;
        }
        if (ver.thread !== c.seenThread) {
          c.res.write("event: thread\ndata: 1\n\n");
          c.seenThread = ver.thread;
          wrote = true;
        }
        if (wrote) {
          c.lastWrite = now;
        } else if (now - c.lastWrite >= HEARTBEAT_S * 1000) {
          c.res.write(": ping\n\n"); // heartbeat; a broken socket surfaces on write/close
          c.lastWrite = now;
        }
      } catch {
        clients.delete(c);
      }
    }
  }, POLL_S * 1000);

  const server = http.createServer((req, res) => {
    if ((req.method === "GET" || req.method === "HEAD") &&
        req.url.split("?", 1)[0] === EVENTS_PATH) {
      // `retry:` sets the client's reconnect backoff; the initial feed+thread
      // events make a freshly-(re)connected client pull both streams once, so a
      // server restart re-syncs the canvas the moment the socket comes back.
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // defeat any buffering proxy
      });
      res.write("retry: 2000\n\nevent: feed\ndata: 1\n\nevent: thread\ndata: 1\n\n");
      const c = {
        res,
        seenFeed: ver.feed,
        seenThread: ver.thread,
        lastWrite: Date.now(),
      };
      clients.add(c);
      req.on("close", () => clients.delete(c));
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(501, { "Content-Type": "text/plain" });
      res.end("Unsupported method");
      return;
    }
    serveFile(root, req, res);
  });
  server.listen(port, "127.0.0.1");
  return server;
}

const isMain = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  const port = parseInt(process.argv[2], 10);
  const root = process.argv[3];
  start(port, root);
}
