#!/usr/bin/env python3
"""Glimpse static file server: serves the canvas, feed, and artifacts from the
served root, bound to loopback only. Invoked as a CLI by `bin/glimpse`.

  glimpse_server.py <port> <root>

Quiet server: `python -m http.server` logs every request to stderr, which grew
.server.log past 100 MB on long runs (the canvas polls the feed constantly).
Suppress per-request logging (keep real errors); threaded + reuse-address to
match the CLI's behavior. Loopback bind — the canvas, feed, and artifacts are
local data. Stdlib only.
"""

import http.server
import os
import socketserver
import sys

port, root = int(sys.argv[1]), sys.argv[2]
os.chdir(root)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):  # drop the per-request access log
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


Server(("127.0.0.1", port), Quiet).serve_forever()
