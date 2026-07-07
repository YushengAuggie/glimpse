"""Push channel (SSE) for the canvas: lib/glimpse_server.py serves an
/__glimpse/events stream that emits a `feed` event when feed.json changes and a
`thread` event when any threads/<slug>.json changes, replacing the canvas's old
busy-poll timers. Offline, stdlib-only — starts the real server on a loopback
ephemeral port and drives it end to end.

Networking goes through http.client, not urllib: urllib honors HTTP(S)_PROXY
env, which some CI runners set, and would route even a 127.0.0.1 request through
a proxy that then can't reach it. http.client connects to the socket directly.
"""

import contextlib
import http.client
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

SERVER = Path(__file__).resolve().parent.parent / "lib" / "glimpse_server.py"


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _get(port, path, timeout=1.0):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request("GET", path)
        r = conn.getresponse()
        return r.status, r.read()
    finally:
        conn.close()


def _wait_up(port, timeout=15.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if _get(port, "/feed.json")[0] == 200:
                return True
        except OSError:
            pass
        time.sleep(0.1)
    return False


def _open_sse(port, timeout=6.0):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    conn.request("GET", "/__glimpse/events")
    resp = conn.getresponse()
    assert resp.status == 200, resp.status
    ctype = resp.getheader("Content-Type", "")
    assert ctype.startswith("text/event-stream"), ctype
    return conn, resp


def _next_events(resp, want):
    """Read SSE `event:` names off an open stream until `want` are collected or a
    read times out / the stream ends (returns what it has)."""
    got = []
    while len(got) < want:
        try:
            line = resp.readline()
        except OSError:
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
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        if not _wait_up(port):
            proc.terminate()
            out = b""
            with contextlib.suppress(Exception):
                out = proc.communicate(timeout=5)[0] or b""
            raise AssertionError(
                "server did not come up; output:\n" + out.decode("utf-8", "replace")
            )
        yield port, tmp_path
    finally:
        proc.terminate()
        with contextlib.suppress(Exception):
            proc.wait(timeout=5)


def test_sse_pushes_feed_and_thread_changes(server):
    port, root = server
    conn, resp = _open_sse(port)
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
        conn.close()


def test_sse_is_loopback_and_carries_no_content(server):
    port, root = server
    # The event body is a bare signal — never the file's (secret-bearing) contents.
    (root / "feed.json").write_text('{"artifacts":[{"slug":"secret-sk-abc","ts":9}]}')
    conn, resp = _open_sse(port)
    try:
        blob = b""
        time.sleep(0.6)
        (root / "feed.json").write_text(
            '{"artifacts":[{"slug":"secret-sk-def","ts":10}]}'
        )
        for _ in range(12):
            try:
                chunk = resp.readline()
            except OSError:
                break
            if not chunk:
                break
            blob += chunk
        assert b"secret-sk" not in blob
        assert b"data: 1" in blob
    finally:
        conn.close()
