#!/usr/bin/env python3
"""Glimpse per-document conversation store: threads/<slug>.json, one exclusive-
locked, atomic read-modify-write so a flocked agent `reply` and the bridge's
pending-question write can never corrupt each other, and the static server never
serves a half-written file. Invoked as a CLI by `bin/glimpse`. Stdlib only.

Subcommands (argv[1]):
  op       env: GLIMPSE_DIR SLUG ACTION plus per-action fields. ACTION ∈
             add_user   SLUG ANCHOR(json) QUOTE TEXT CLIENT_TURN_ID ARTIFACT_TS TS  → prints the turn id
             add_agent  SLUG TEXT TO TS                                            → prints the turn id, flips TO→answered
             clear      SLUG
             print      SLUG            (readable transcript)
             print_json SLUG            (raw file)
           Turn text/quote are capped and secret-scrubbed; files are chmod 0600.
  list     env: GLIMPSE_DIR — list conversation threads.
  pending  env: GLIMPSE_DIR — print pending user turns as JSON lines
             ({type,id,slug,ts,quote,text,anchor}); consumed by the bridge + `glimpse poll`.
"""

import json
import os
import sys


def cmd_op():
    import fcntl
    import re
    import time

    root = os.environ["GLIMPSE_DIR"]
    action = os.environ["ACTION"]
    slug = os.environ["SLUG"]
    tdir = os.path.join(root, "threads")
    os.makedirs(tdir, exist_ok=True)
    fp = os.path.join(tdir, slug + ".json")
    TURN_CAP = int(os.environ.get("GLIMPSE_TURN_CAP", "2000"))
    TEXT_CAP = int(os.environ.get("GLIMPSE_TEXT_CAP", str(64 * 1024)))
    SECRET = os.environ.get("SECRET_PATTERN", "")
    _secret_re = None
    if SECRET:
        try:
            _secret_re = re.compile("(" + SECRET + ")")
        except re.error:
            _secret_re = None

    def scrub(s):
        s = s or ""
        if _secret_re is not None:
            s = _secret_re.sub("[REDACTED]", s)
        return s[:TEXT_CAP]

    def now():
        return int(os.environ.get("TS") or time.time())

    lf = open(fp + ".lock", "w")
    fcntl.flock(lf, fcntl.LOCK_EX)
    try:
        try:
            with open(fp) as fh:
                data = json.load(fh)
        except Exception:
            data = {"version": 1, "slug": slug, "artifactTs": None, "turns": []}
        turns = data.setdefault("turns", [])
        dirty = False
        out = None

        if action == "add_user":
            cid = os.environ.get("CLIENT_TURN_ID", "")
            ex = next((t for t in turns if cid and t.get("clientTurnId") == cid), None)
            if ex:  # idempotent: same question delivered twice
                out = ex["id"]
            else:
                if len(turns) >= TURN_CAP:
                    raise SystemExit(
                        "glimpse: thread '%s' is full (%d turns)" % (slug, TURN_CAP)
                    )
                ts = now()
                tid = "%d-%d-%s" % (
                    ts,
                    len(turns) + 1,
                    os.urandom(2).hex(),
                )  # suffix avoids post-clear id reuse
                anchor = None
                if os.environ.get("ANCHOR"):
                    try:
                        anchor = json.loads(os.environ["ANCHOR"])
                    except Exception:
                        anchor = None
                if isinstance(anchor, dict):
                    if anchor.get("kind") == "node":
                        # node anchor: scrub agent text fields; no occurrence (keyed by id).
                        for k in ("label", "file", "lines"):
                            if isinstance(anchor.get(k), str):
                                anchor[k] = scrub(anchor[k])
                            elif k in anchor:
                                anchor.pop(k, None)
                        if not isinstance(anchor.get("id"), str):
                            anchor = None
                        else:
                            anchor = {
                                "kind": "node",
                                "id": anchor["id"],
                                "label": anchor.get("label", ""),
                                "file": anchor.get("file", ""),
                                "lines": anchor.get("lines", ""),
                            }
                    else:
                        # The anchor carries the *selected text* (exact/prefix/suffix); scrub +
                        # cap it like quote/text — it would otherwise smuggle secrets past the guard.
                        for k in ("exact", "prefix", "suffix"):
                            if isinstance(anchor.get(k), str):
                                anchor[k] = scrub(anchor[k])
                            elif k in anchor:
                                anchor.pop(k, None)
                        try:
                            anchor["occurrence"] = int(anchor.get("occurrence", 0))
                        except Exception:
                            anchor["occurrence"] = 0
                else:
                    anchor = None
                if os.environ.get("ARTIFACT_TS"):
                    try:
                        data["artifactTs"] = int(os.environ["ARTIFACT_TS"])
                    except Exception:
                        pass
                t = {
                    "id": tid,
                    "role": "user",
                    "status": "pending",
                    "anchor": anchor,
                    "quote": scrub(os.environ.get("QUOTE", "")),
                    "text": scrub(os.environ.get("TEXT", "")),
                    "ts": ts,
                }
                if cid:
                    t["clientTurnId"] = cid
                turns.append(t)
                out = tid
                dirty = True
        elif action == "add_agent":
            to = os.environ["TO"]
            u = next(
                (t for t in turns if t.get("id") == to and t.get("role") == "user"),
                None,
            )
            if u is None:
                raise SystemExit(
                    "glimpse: no user turn '%s' in thread '%s'" % (to, slug)
                )
            ex = next(
                (
                    t
                    for t in turns
                    if t.get("role") == "agent" and t.get("replyTo") == to
                ),
                None,
            )
            if ex:  # idempotent: one answer per question (re-delivery is a no-op)
                out = ex["id"]
            else:
                if len(turns) >= TURN_CAP:
                    raise SystemExit(
                        "glimpse: thread '%s' is full (%d turns)" % (slug, TURN_CAP)
                    )
                ts = now()
                tid = "%d-%d-%s" % (ts, len(turns) + 1, os.urandom(2).hex())
                turns.append(
                    {
                        "id": tid,
                        "role": "agent",
                        "replyTo": to,
                        "text": scrub(os.environ.get("TEXT", "")),
                        "ts": ts,
                    }
                )
                u["status"] = "answered"
                out = tid
                dirty = True
        elif action == "clear":
            if not os.path.exists(fp):
                raise SystemExit("glimpse: no thread '%s'" % slug)
            os.remove(fp)  # delete outright so it leaves the `threads` listing too
        elif action == "print_json":
            if not os.path.exists(fp):
                raise SystemExit("glimpse: no thread '%s'" % slug)
            print(json.dumps(data, indent=2))
        elif action == "print":
            if not os.path.exists(fp):
                raise SystemExit("glimpse: no thread '%s'" % slug)
            n = len(turns)
            print("# thread: %s   (%d turn%s)" % (slug, n, "" if n == 1 else "s"))
            for t in turns:
                if t.get("role") == "user":
                    q = (t.get("quote") or "").replace("\n", " ").strip()
                    if len(q) > 80:
                        q = q[:79] + "…"
                    print("\n[user %s · %s]" % (t["id"], t.get("status", "")))
                    if q:
                        print("  ❝%s❞" % q)
                    print("  Q: %s" % (t.get("text") or "").strip())
                else:
                    print("[agent → %s]" % t.get("replyTo", ""))
                    print("  %s" % (t.get("text") or "").strip())

        if dirty:
            tmp = fp + ".tmp"
            with open(tmp, "w") as fh:
                json.dump(data, fh, indent=2)
            os.replace(tmp, fp)
            os.chmod(fp, 0o600)
        if out is not None:
            print(out)
    finally:
        fcntl.flock(lf, fcntl.LOCK_UN)
        lf.close()


def cmd_list():
    tdir = os.path.join(os.environ["GLIMPSE_DIR"], "threads")
    try:
        files = sorted(f for f in os.listdir(tdir) if f.endswith(".json"))
    except FileNotFoundError:
        files = []
    if not files:
        print("(no threads)")
        raise SystemExit
    for f in files:
        try:
            with open(os.path.join(tdir, f)) as fh:
                d = json.load(fh)
        except Exception:
            continue
        turns = d.get("turns", [])
        n = len(turns)
        pend = sum(
            1 for t in turns if t.get("role") == "user" and t.get("status") == "pending"
        )
        print(
            "%-28s %3d turn%s%s"
            % (
                f[:-5],
                n,
                "" if n == 1 else "s",
                ("  (%d pending)" % pend) if pend else "",
            )
        )


def cmd_pending():
    tdir = os.path.join(os.environ["GLIMPSE_DIR"], "threads")
    try:
        files = sorted(f for f in os.listdir(tdir) if f.endswith(".json"))
    except FileNotFoundError:
        files = []
    for f in files:
        try:
            with open(os.path.join(tdir, f)) as fh:
                d = json.load(fh)
        except Exception:
            continue
        slug = d.get("slug") or f[:-5]
        for t in d.get("turns", []):
            if t.get("role") == "user" and t.get("status") == "pending":
                print(
                    json.dumps(
                        {
                            "type": "question",
                            "id": t["id"],
                            "slug": slug,
                            "ts": t.get("ts"),
                            "quote": t.get("quote", ""),
                            "text": t.get("text", ""),
                            "anchor": t.get("anchor"),
                        }
                    )
                )


_DISPATCH = {"op": cmd_op, "list": cmd_list, "pending": cmd_pending}

if __name__ == "__main__":
    sub = sys.argv[1] if len(sys.argv) > 1 else ""
    fn = _DISPATCH.get(sub)
    if fn is None:
        sys.stderr.write("glimpse_threads.py: unknown subcommand %r\n" % sub)
        raise SystemExit(2)
    fn()
