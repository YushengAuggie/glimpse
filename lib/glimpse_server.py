#!/usr/bin/env python3
"""Glimpse static file server: serves the canvas, feed, and artifacts from the
served root, bound to loopback only. Invoked as a CLI by `bin/glimpse`.

  glimpse_server.py <port> <root>

Quiet server: `python -m http.server` logs every request to stderr, which grew
.server.log past 100 MB on long runs. Suppress per-request logging (keep real
errors); threaded + reuse-address to match the CLI's behavior. Loopback bind —
the canvas, feed, and artifacts are local data. Stdlib only.

Push freshness (SSE): the canvas used to busy-poll feed.json (~1.2s) and
threads/<slug>.json (~1s) on timers. Instead, ONE background thread stats those
files' mtimes and bumps a per-stream version; clients connected to the SSE
endpoint (GET /__glimpse/events) block on a condition and are woken the instant
either stream advances, so the browser no longer polls in the steady state.
The event body carries only a `feed`/`thread` signal — never file content — so
it can leak nothing the served files don't already expose. Loopback only.
"""

import http.server
import os
import socketserver
import sys
import threading
import time

port, root = int(sys.argv[1]), sys.argv[2]
os.chdir(root)

EVENTS_PATH = "/__glimpse/events"
POLL_S = 0.4  # server-side stat cadence (cheap: stat only, no HTTP/JSON/render)
HEARTBEAT_S = 15  # idle SSE keepalive comment → keeps the socket open + surfaces a drop

# Per-stream monotonic versions, bumped by the watcher thread and read by every
# SSE handler under this condition. A handler remembers the version it last sent
# and emits only the streams that advanced, so coalesced changes are never lost.
_cond = threading.Condition()
_ver = {"feed": 0, "thread": 0}


def _scan():
    """Return (feed_sig, thread_sig) — cheap change fingerprints. feed uses
    (mtime, size); threads uses (max mtime, file count) so a new/removed thread
    file registers even when mtimes collide on a coarse-resolution filesystem."""
    try:
        st = os.stat("feed.json")
        feed = (st.st_mtime, st.st_size)
    except OSError:
        feed = None
    tmax, tcount = 0.0, 0
    try:
        with os.scandir("threads") as it:
            for e in it:
                if not e.name.endswith(".json"):
                    continue
                tcount += 1
                try:
                    m = e.stat().st_mtime
                except OSError:
                    continue
                if m > tmax:
                    tmax = m
    except OSError:
        pass
    return feed, (tmax, tcount)


def _watch():
    last = _scan()  # baseline: don't bump on the first observation
    while True:
        time.sleep(POLL_S)
        cur = _scan()
        with _cond:
            changed = False
            if cur[0] != last[0]:
                _ver["feed"] += 1
                changed = True
            if cur[1] != last[1]:
                _ver["thread"] += 1
                changed = True
            if changed:
                _cond.notify_all()
        last = cur


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):  # drop the per-request access log
        pass

    def do_GET(self):
        if self.path.split("?", 1)[0] == EVENTS_PATH:
            self._serve_events()
            return
        return super().do_GET()

    def _serve_events(self):
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.send_header("X-Accel-Buffering", "no")  # defeat any buffering proxy
            self.end_headers()
            # `retry:` sets the client's reconnect backoff; the initial feed+thread
            # events make a freshly-(re)connected client pull both streams once, so a
            # server restart re-syncs the canvas the moment the socket comes back.
            self.wfile.write(
                b"retry: 2000\n\nevent: feed\ndata: 1\n\nevent: thread\ndata: 1\n\n"
            )
            self.wfile.flush()
        except OSError:
            return
        with _cond:
            seen_f, seen_t = _ver["feed"], _ver["thread"]
        while True:
            with _cond:
                if _ver["feed"] == seen_f and _ver["thread"] == seen_t:
                    _cond.wait(timeout=HEARTBEAT_S)
                cur_f, cur_t = _ver["feed"], _ver["thread"]
            try:
                wrote = False
                if cur_f != seen_f:
                    self.wfile.write(b"event: feed\ndata: 1\n\n")
                    seen_f = cur_f
                    wrote = True
                if cur_t != seen_t:
                    self.wfile.write(b"event: thread\ndata: 1\n\n")
                    seen_t = cur_t
                    wrote = True
                if not wrote:
                    self.wfile.write(
                        b": ping\n\n"
                    )  # heartbeat; a broken socket raises here
                self.wfile.flush()
            except OSError:
                break


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


threading.Thread(target=_watch, daemon=True).start()
Server(("127.0.0.1", port), Quiet).serve_forever()
