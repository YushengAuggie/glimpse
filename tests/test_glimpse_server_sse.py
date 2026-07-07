"""Push channel (SSE) for the canvas: lib/glimpse_server.py serves an
/__glimpse/events stream that emits a `feed` event when feed.json changes and a
`thread` event when any threads/<slug>.json changes, replacing the canvas's old
busy-poll timers. Offline, stdlib-only — starts the real server on a loopback
ephemeral port and drives it end to end.
"""

import contextlib
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

SERVER = Path(__file__).resolve().parent.parent / "lib" / "glimpse_server.py"


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _wait_up(port, timeout=5.0):
    end = time.time() + timeout
    url = f"http://127.0.0.1:{port}/feed.json"
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=0.5) as r:
                r.read()
            return True
        except Exception:
            time.sleep(0.05)
    return False


def _next_events(resp, want, timeout=6.0):
    """Read SSE `event:` names off an open stream until `want` are collected or
    the per-read socket timeout trips (returns what it has)."""
    got = []
    while len(got) < want:
        try:
            line = resp.readline()
        except Exception:
            break
        if not line:
            break
        line = line.decode("utf-8", "replace").strip()
        if line.startswith("event:"):
            got.append(line.split(":", 1)[1].strip())
    return got


@pytest.fixture()
def server(tmp_path):
    (tmp_path / "feed.json").write_text('{"artifacts":[]}')
    (tmp_path / "threads").mkdir()
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, str(SERVER), str(port), str(tmp_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        assert _wait_up(port), "server did not come up"
        yield port, tmp_path
    finally:
        proc.terminate()
        with contextlib.suppress(Exception):
            proc.wait(timeout=5)


def test_sse_pushes_feed_and_thread_changes(server):
    port, root = server
    resp = urllib.request.urlopen(
        f"http://127.0.0.1:{port}/__glimpse/events", timeout=6
    )
    try:
        # A freshly-connected client is told to pull both streams once.
        assert _next_events(resp, 2) == ["feed", "thread"]

        # Feed change → a `feed` event, not a `thread` one.
        time.sleep(0.5)
        (root / "feed.json").write_text(
            '{"artifacts":[{"slug":"x","ts":1,"title":"X"}]}'
        )
        assert _next_events(resp, 1) == ["feed"]

        # Thread change → a `thread` event.
        time.sleep(0.5)
        (root / "threads" / "x.json").write_text('{"turns":[{"id":"1","role":"user"}]}')
        assert _next_events(resp, 1) == ["thread"]
    finally:
        resp.close()


def test_sse_is_loopback_and_carries_no_content(server):
    port, root = server
    # The event body is a bare signal — never the file's contents.
    (root / "feed.json").write_text('{"artifacts":[{"slug":"secret-sk-abc","ts":9}]}')
    resp = urllib.request.urlopen(
        f"http://127.0.0.1:{port}/__glimpse/events", timeout=6
    )
    try:
        blob = b""
        # Trigger a change, then read a bounded slice covering the handshake +
        # the change event. The stream must carry only `event:`/`data: 1` signal
        # lines — never the changed file's (secret-bearing) contents.
        time.sleep(0.6)
        (root / "feed.json").write_text(
            '{"artifacts":[{"slug":"secret-sk-def","ts":10}]}'
        )
        for _ in range(12):
            try:
                chunk = resp.readline()
            except Exception:
                break
            if not chunk:
                break
            blob += chunk
        assert b"secret-sk" not in blob
        assert b"data: 1" in blob
    finally:
        resp.close()
