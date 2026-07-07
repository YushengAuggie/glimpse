"""Multi-artifact isolation for the per-document thread store (roadmap item K).

Glimpse keys every feedback/highlight stream per artifact by slug: threads live in
threads/<slug>.json, one exclusive-locked read-modify-write each. These tests pin
that two concurrently-active artifacts never bleed into each other's thread, pending
queue, or reply routing — and that clearing/one-shot ops on A leave B untouched — so
several published artifacts (and the agents addressing them) stay independent.

Driven through glimpse_threads.py exactly as bin/glimpse invokes it (env-passed args,
subprocess), so the test exercises the real CLI contract the bridge/agent rely on.
"""

import json
import os
import subprocess
import sys

THREADS_PY = os.path.join(os.path.dirname(__file__), "..", "lib", "glimpse_threads.py")


def _op(root, action, **env):
    """Run `glimpse_threads.py op` with ACTION + fields in env; return stdout."""
    e = dict(os.environ, GLIMPSE_DIR=str(root), ACTION=action)
    for k, v in env.items():
        e[k] = "" if v is None else str(v)
    r = subprocess.run(
        [sys.executable, THREADS_PY, "op"],
        env=e,
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, f"op {action} failed: {r.stderr}"
    return r.stdout.strip()


def _run(root, sub):
    r = subprocess.run(
        [sys.executable, THREADS_PY, sub],
        env=dict(os.environ, GLIMPSE_DIR=str(root)),
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, f"{sub} failed: {r.stderr}"
    return r.stdout


def _pending(root):
    return [
        json.loads(line) for line in _run(root, "pending").splitlines() if line.strip()
    ]


def _add_user(root, slug, text, quote="", cid=None):
    return _op(root, "add_user", SLUG=slug, TEXT=text, QUOTE=quote, CLIENT_TURN_ID=cid)


def test_two_artifacts_keep_separate_threads(tmp_path):
    root = tmp_path / "glimpse"
    a = _add_user(root, "alpha", "what is A?", quote="q on A", cid="cA1")
    b = _add_user(root, "beta", "what is B?", quote="q on B", cid="cB1")
    assert a and b and a != b

    # Each thread holds only its own turn — no cross-artifact bleed.
    ta = json.loads(_op(root, "print_json", SLUG="alpha"))
    tb = json.loads(_op(root, "print_json", SLUG="beta"))
    assert ta["slug"] == "alpha" and [t["text"] for t in ta["turns"]] == ["what is A?"]
    assert tb["slug"] == "beta" and [t["text"] for t in tb["turns"]] == ["what is B?"]

    # pending lists both, each tagged with its own slug.
    pend = _pending(root)
    assert {p["slug"] for p in pend} == {"alpha", "beta"}
    assert {p["id"]: p["slug"] for p in pend} == {a: "alpha", b: "beta"}


def test_reply_addresses_only_its_artifact(tmp_path):
    root = tmp_path / "glimpse"
    a = _add_user(root, "alpha", "q A", cid="cA1")
    _add_user(root, "beta", "q B", cid="cB1")

    # Answer alpha's turn; beta must remain pending and unanswered.
    _op(root, "add_agent", SLUG="alpha", TEXT="A answered", TO=a)
    pend = _pending(root)
    assert [p["slug"] for p in pend] == ["beta"], "only beta should still be pending"

    ta = json.loads(_op(root, "print_json", SLUG="alpha"))
    assert [t.get("status") for t in ta["turns"] if t["role"] == "user"] == ["answered"]
    tb = json.loads(_op(root, "print_json", SLUG="beta"))
    assert [t.get("status") for t in tb["turns"] if t["role"] == "user"] == ["pending"]
    # alpha's agent reply is anchored to alpha's turn, never beta's.
    assert [t["replyTo"] for t in ta["turns"] if t["role"] == "agent"] == [a]


def test_reply_to_foreign_turn_id_is_rejected(tmp_path):
    """A turn id from artifact A cannot be answered inside artifact B's thread."""
    root = tmp_path / "glimpse"
    a = _add_user(root, "alpha", "q A", cid="cA1")
    _add_user(root, "beta", "q B", cid="cB1")
    r = subprocess.run(
        [sys.executable, THREADS_PY, "op"],
        env=dict(
            os.environ,
            GLIMPSE_DIR=str(root),
            ACTION="add_agent",
            SLUG="beta",
            TEXT="wrong",
            TO=a,
        ),
        capture_output=True,
        text=True,
    )
    assert r.returncode != 0, "answering alpha's turn under beta must fail"
    assert "no user turn" in r.stderr


def test_clear_one_artifact_leaves_the_other(tmp_path):
    root = tmp_path / "glimpse"
    _add_user(root, "alpha", "q A", cid="cA1")
    _add_user(root, "beta", "q B", cid="cB1")
    _op(root, "clear", SLUG="alpha")

    # alpha's thread is gone; beta's is intact and still pending.
    tdir = root / "threads"
    assert not (tdir / "alpha.json").exists()
    assert (tdir / "beta.json").exists()
    assert [p["slug"] for p in _pending(root)] == ["beta"]


def test_same_client_turn_id_across_artifacts_does_not_collide(tmp_path):
    """clientTurnId dedup is scoped to one thread — the same id on two slugs is two turns."""
    root = tmp_path / "glimpse"
    a = _add_user(root, "alpha", "q A", cid="dup")
    b = _add_user(root, "beta", "q B", cid="dup")
    assert a != b, "identical clientTurnId on different slugs must be distinct turns"
    # Re-delivering the SAME slug+cid is idempotent (returns the existing turn).
    assert _add_user(root, "alpha", "q A again", cid="dup") == a
