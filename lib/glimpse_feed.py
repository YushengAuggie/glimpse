#!/usr/bin/env python3
"""Glimpse feed store: the flocked read-modify-write ops on feed.json, invoked as
a CLI by `bin/glimpse`. Stdlib only.

Subcommands (argv[1]):
  upsert   env: GLIMPSE_DIR SLUG TITLE TS PENDING(0|1) NOANNOTATE(0|1) KIND
           upsert one artifact into feed.json.
  op       env: GLIMPSE_DIR ACTION(remove|removeall|keep|pin|unpin) [SLUGS KEEP SLUG]
           mutate feed.json; prints removed slugs (one per line) for remove/removeall/keep.
  list     env: GLIMPSE_DIR
           list artifacts (pinned first).
"""

import json
import os
import sys
import time


# Upsert one artifact into feed.json under an exclusive lock (serializes the
# read-modify-write so concurrent publishes can't drop each other's entry).
def cmd_upsert():
    import fcntl

    root = os.environ["GLIMPSE_DIR"]
    slug = os.environ["SLUG"]
    title = os.environ["TITLE"]
    ts = int(os.environ["TS"])
    pending = os.environ["PENDING"] == "1"
    noann = os.environ.get("NOANNOTATE") == "1"
    kind = os.environ.get("KIND", "")
    fp = os.path.join(root, "feed.json")
    lf = open(fp + ".lock", "w")
    fcntl.flock(lf, fcntl.LOCK_EX)
    try:
        try:
            feed = json.load(open(fp))
        except Exception:
            feed = {"artifacts": []}
        old = next((a for a in feed.get("artifacts", []) if a.get("slug") == slug), {})
        arts = [a for a in feed.get("artifacts", []) if a.get("slug") != slug]
        e = {"slug": slug, "title": title, "ts": ts}
        if pending:
            e["pending"] = True
        if noann:
            e["noannotate"] = True  # shell skips highlight-chat injection
        if kind:
            e["kind"] = kind  # "explain" → shell inlines glimpse-explain.js
        if old.get("pinned"):
            e["pinned"] = True  # preserve a pin across re-publish
        arts.append(e)
        tmp = fp + ".tmp"
        with open(tmp, "w") as fh:
            json.dump({"artifacts": arts}, fh, indent=2)
        os.replace(tmp, fp)  # atomic: a poll never sees partial JSON
    finally:
        fcntl.flock(lf, fcntl.LOCK_UN)
        lf.close()


# Mutate feed.json under an exclusive lock. ACTION ∈ remove|removeall|keep|pin|unpin.
# For remove/removeall/keep it prints the removed slugs (one per line) so the
# caller can delete the matching artifact files.
def cmd_op():
    import fcntl

    root = os.environ["GLIMPSE_DIR"]
    action = os.environ["ACTION"]
    fp = os.path.join(root, "feed.json")
    lf = open(fp + ".lock", "w")
    fcntl.flock(lf, fcntl.LOCK_EX)
    try:
        try:
            arts = json.load(open(fp)).get("artifacts", [])
        except Exception:
            arts = []
        removed = []
        if action == "remove":
            s = set(os.environ.get("SLUGS", "").split())
            removed = [a["slug"] for a in arts if a["slug"] in s]
            arts = [a for a in arts if a["slug"] not in s]
        elif action == "removeall":
            removed = [a["slug"] for a in arts]
            arts = []
        elif action == "keep":
            n = int(os.environ["KEEP"])
            # break ties on insertion order so equal-ts artifacts keep the NEWEST n
            order = [
                a
                for _, a in sorted(
                    enumerate(arts),
                    key=lambda p: (p[1].get("ts", 0), p[0]),
                    reverse=True,
                )
            ]
            keep = [a for a in order if a.get("pinned")] + [
                a for a in order if not a.get("pinned")
            ][:n]
            ks = {a["slug"] for a in keep}
            removed = [a["slug"] for a in arts if a["slug"] not in ks]
            arts = [a for a in arts if a["slug"] in ks]
        elif action in ("pin", "unpin"):
            sl = os.environ["SLUG"]
            for a in arts:
                if a["slug"] == sl:
                    if action == "pin":
                        a["pinned"] = True
                    else:
                        a.pop("pinned", None)
        tmp = fp + ".tmp"
        with open(tmp, "w") as fh:
            json.dump({"artifacts": arts}, fh, indent=2)
        os.replace(tmp, fp)
        for r in removed:
            print(r)
    finally:
        fcntl.flock(lf, fcntl.LOCK_UN)
        lf.close()


def cmd_list():
    fp = os.path.join(os.environ["GLIMPSE_DIR"], "feed.json")
    try:
        arts = json.load(open(fp)).get("artifacts", [])
    except Exception:
        arts = []
    arts = sorted(arts, key=lambda a: (not a.get("pinned"), -a.get("ts", 0)))
    # Machine-readable escape hatch for agents (mirrors `glimpse poll --json`): one
    # compact JSON object, valid whether or not there are artifacts.
    if os.environ.get("LIST_JSON") == "1":
        print(json.dumps({"artifacts": arts}))
        raise SystemExit
    if not arts:
        print("(no artifacts)")
        raise SystemExit
    now = time.time()
    for a in arts:
        age = now - a.get("ts", now)
        d = (
            ("%dm" % (age // 60))
            if age < 3600
            else (("%dh" % (age // 3600)) if age < 86400 else ("%dd" % (age // 86400)))
        )
        mark = "*" if a.get("pinned") else " "
        pend = " [awaiting]" if a.get("pending") else ""
        print(
            "%s %-26s %4s  %s%s" % (mark, a["slug"], d, a.get("title", "")[:48], pend)
        )


_DISPATCH = {"upsert": cmd_upsert, "op": cmd_op, "list": cmd_list}

if __name__ == "__main__":
    sub = sys.argv[1] if len(sys.argv) > 1 else ""
    fn = _DISPATCH.get(sub)
    if fn is None:
        sys.stderr.write("glimpse_feed.py: unknown subcommand %r\n" % sub)
        raise SystemExit(2)
    fn()
