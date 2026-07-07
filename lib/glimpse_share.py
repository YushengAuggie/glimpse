#!/usr/bin/env python3
"""Glimpse share: upload one self-contained HTML document to the ht-ml.app hosting
API and print the visitable URL + secret update key, invoked as a CLI by
`bin/glimpse`. Stdlib only (urllib), no third-party deps.

  glimpse_share.py            # HTML on stdin

This is the ONLY part of glimpse that reaches the network for a user artifact.
The endpoint host is anchored to ht-ml.app and cannot be pointed elsewhere — a
GLIMPSE_HTML_APP_BASE override is validated to that domain before any request.

Env:
  GLIMPSE_PASSWORD        if non-empty, publish a PRIVATE (password-protected)
                          page with this shared secret; empty ⇒ fully public.
  GLIMPSE_HTML_APP_BASE   API base (default https://api.ht-ml.app/v1); host must
                          be ht-ml.app.
  GLIMPSE_HTML_APP_TOKEN  optional bearer token (never required).

Prints a JSON object to stdout on success:
  {"url": …, "site_id": …, "update_key": …, "private": true|false}
On failure, prints an actionable line to stderr and exits non-zero.
"""

import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BASE = "https://api.ht-ml.app/v1"
_ALLOWED_DOMAIN = "ht-ml.app"


def _anchored_base():
    """The API base, refusing any host that isn't ht-ml.app (anchored match)."""
    base = os.environ.get("GLIMPSE_HTML_APP_BASE", "").strip() or DEFAULT_BASE
    from urllib.parse import urlparse

    parsed = urlparse(base)
    if parsed.scheme not in ("https", "http"):
        raise ValueError(f"refusing non-http(s) share endpoint: {base}")
    host = (parsed.hostname or "").lower()
    if not (host == _ALLOWED_DOMAIN or host.endswith("." + _ALLOWED_DOMAIN)):
        raise ValueError(f"refusing share endpoint outside {_ALLOWED_DOMAIN}: {base}")
    return base.rstrip("/")


def main():
    html = sys.stdin.read()
    if not html.strip():
        sys.stderr.write("glimpse share: empty document — nothing to upload\n")
        return 1

    try:
        base = _anchored_base()
    except ValueError as exc:
        sys.stderr.write(f"glimpse share: {exc}\n")
        return 1

    password = os.environ.get("GLIMPSE_PASSWORD", "")
    body = {"html_content": html}
    if password:
        body["password"] = password

    req = urllib.request.Request(
        f"{base}/sites",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    token = os.environ.get("GLIMPSE_HTML_APP_TOKEN", "").strip()
    if token:
        req.add_header("Authorization", f"Bearer {token}")

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            err = json.loads(exc.read().decode("utf-8"))
            detail = err.get("message") or err.get("detail") or ""
        except Exception:
            pass
        hint = ""
        if exc.code == 422:
            hint = " (the HTML failed ht-ml.app's content-safety scan)"
        sys.stderr.write(
            f"glimpse share: upload failed — HTTP {exc.code}{hint}: {detail}\n"
        )
        return 1
    except urllib.error.URLError as exc:
        sys.stderr.write(f"glimpse share: could not reach {base} — {exc.reason}\n")
        return 1

    url = payload.get("url")
    if not url:
        sys.stderr.write(
            f"glimpse share: unexpected response from ht-ml.app: {payload}\n"
        )
        return 1

    print(
        json.dumps(
            {
                "url": url,
                "site_id": payload.get("site_id", ""),
                "update_key": payload.get("update_key", ""),
                "private": bool(password),
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
