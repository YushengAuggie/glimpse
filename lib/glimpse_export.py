#!/usr/bin/env python3
"""Glimpse export: inline a published artifact's LOCAL assets into one portable,
self-contained HTML document, invoked as a CLI by `bin/glimpse`. Stdlib only.

  glimpse_export.py <src.html>

Reads the artifact at <src.html>, inlines every asset it references by a *local*
relative path — stylesheets, scripts, images, fonts, and url(...) refs inside CSS
— as inline <style>/<script> or data: URIs, so the result opens in any browser
with no Glimpse server and no sibling files. Prints the bundled HTML to stdout;
one warning per un-inlinable ref to stderr.

Deliberately left as network links (this is a feature — do NOT vendor them):
  - absolute URLs (https://, http://), protocol-relative (//cdn…), data:, blob:,
    mailto:/tel:, and in-page anchors (#…). A Mermaid or Tailwind CDN <script>/<link>
    loads over the network, exactly as it did on the canvas.
  - root-absolute paths (/foo.css): a portable file has no server root to resolve
    them against, so they are left unchanged with a warning.

Security posture (mirrors the rest of glimpse):
  - File reads are CONFINED to the artifact's own directory. A ref that resolves
    (via ../ or a symlink) outside that directory is refused and left unchanged —
    export never reaches into the wider filesystem.
  - The final bundle is scrubbed against SECRET_PATTERN (env, shared with the
    thread/secret guard): anything matching is replaced with «redacted», so a
    secret that slipped into an artifact or a local asset is never baked into a
    portable file that leaves the machine.
"""

import base64
import mimetypes
import os
import re
import sys

# Assets larger than this are left as links rather than inlined, so a stray huge
# file can't blow the bundle up. Override with GLIMPSE_EXPORT_MAX_ASSET_BYTES.
MAX_ASSET_BYTES = int(
    os.environ.get("GLIMPSE_EXPORT_MAX_ASSET_BYTES", str(8 * 1024 * 1024))
)
# @import / url() recursion in CSS is bounded so a cyclic import can't spin forever.
MAX_CSS_DEPTH = 8

# Extensions the stdlib mimetypes table misses or gets wrong for the web fonts /
# image types artifacts commonly reference.
_EXTRA_MIME = {
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".css": "text/css",
}

_WARNINGS = []


def _warn(kind, ref, reason=""):
    _WARNINGS.append((kind, ref, reason))


def _is_remote(ref):
    """A ref we deliberately leave as a network/opaque link (never inline)."""
    r = ref.strip()
    if not r:
        return True
    # scheme:// , protocol-relative, data/blob/mailto/tel, in-page anchor
    return bool(
        re.match(
            r"^[a-zA-Z][a-zA-Z0-9+.-]*:", r
        )  # any scheme: (http, https, data, blob, mailto, tel, file…)
        or r.startswith("//")
        or r.startswith("#")
    )


def _guarded_path(base_dir, ref):
    """Resolve a local ref under base_dir, refusing anything that escapes it.

    Strips any ?query / #fragment first (asset refs may carry a cache-buster).
    Returns an absolute path inside base_dir, or None if it can't/shouldn't be read.
    """
    clean = re.split(r"[?#]", ref, 1)[0]
    if not clean:
        return None
    if clean.startswith("/"):
        _warn(
            "root-absolute", ref, "no server root in a portable file — left as a link"
        )
        return None
    base = os.path.realpath(base_dir)
    target = os.path.realpath(os.path.join(base, clean))
    if target != base and not target.startswith(base + os.sep):
        _warn("outside-root", ref, "resolves outside the artifact directory — refused")
        return None
    if not os.path.isfile(target):
        _warn("missing", ref, "file not found next to the artifact")
        return None
    return target


def _mime_for(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in _EXTRA_MIME:
        return _EXTRA_MIME[ext]
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"


def _read_bytes(path, ref):
    try:
        size = os.path.getsize(path)
    except OSError:
        _warn("missing", ref, "could not stat file")
        return None
    if size > MAX_ASSET_BYTES:
        _warn(
            "too-large", ref, f"{size} bytes > {MAX_ASSET_BYTES} limit — left as a link"
        )
        return None
    try:
        with open(path, "rb") as fh:
            return fh.read()
    except OSError as exc:
        _warn("load-failed", ref, str(exc))
        return None


def _data_uri(base_dir, ref):
    """A data: URI for a local ref, or None to leave the ref unchanged."""
    if _is_remote(ref):
        return None
    path = _guarded_path(base_dir, ref)
    if not path:
        return None
    raw = _read_bytes(path, ref)
    if raw is None:
        return None
    mime = _mime_for(path)
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


# --- CSS: inline url(...) refs and @import, relative to the CSS file's dir ---


def _inline_css(css, css_dir, depth):
    if depth > MAX_CSS_DEPTH:
        _warn("css-depth", css_dir, "@import nesting too deep — stopped inlining")
        return css

    # @import "x.css";  /  @import url("x.css") screen;  — splice the imported
    # sheet in place (recursively) so the bundle needs no sibling CSS.
    def _imp(m):
        ref = m.group("url") or m.group("bare")
        if not ref or _is_remote(ref):
            return m.group(0)
        path = _guarded_path(css_dir, ref)
        if not path:
            return m.group(0)
        raw = _read_bytes(path, ref)
        if raw is None:
            return m.group(0)
        media = (m.group("media") or "").strip()
        inner = _inline_css(
            raw.decode("utf-8", "replace"), os.path.dirname(path), depth + 1
        )
        return f"@media {media}{{{inner}}}" if media else inner

    css = re.sub(
        r"""@import\s+(?:url\(\s*(?P<q1>['"]?)(?P<url>[^'")]+)(?P=q1)\s*\)|(?P<q2>['"])(?P<bare>[^'"]+)(?P=q2))(?P<media>[^;]*);""",
        _imp,
        css,
    )

    # url(...) — fonts, background images, etc.
    def _url(m):
        quote = m.group("q") or ""
        ref = m.group("u")
        uri = _data_uri(css_dir, ref)
        if uri is None:
            return m.group(0)
        return f"url({quote}{uri}{quote})"

    css = re.sub(r"""url\(\s*(?P<q>['"]?)(?P<u>[^'")]+)(?P=q)\s*\)""", _url, css)
    return css


# --- HTML tag rewriting (pragmatic regex over generated, well-formed HTML) ---

_ATTR_RE = re.compile(
    r"""([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))"""
)


def _attrs(tag_inner):
    out = {}
    for m in _ATTR_RE.finditer(tag_inner):
        val = (
            m.group(3)
            if m.group(3) is not None
            else (m.group(4) if m.group(4) is not None else m.group(5))
        )
        out[m.group(1).lower()] = val or ""
    return out


def _set_attr(tag, name, value):
    """Replace name="…"/name='…' in a raw tag string, preserving the quote style."""
    pat = re.compile(
        r"(\b" + re.escape(name) + r"\s*=\s*)(\"[^\"]*\"|'[^']*'|[^\s>]+)",
        re.IGNORECASE,
    )
    return pat.sub(lambda m: m.group(1) + '"' + value + '"', tag, count=1)


def _drop_attr(tag, name):
    return re.sub(
        r"\s+" + re.escape(name) + r"\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)",
        "",
        tag,
        count=1,
        flags=re.IGNORECASE,
    )


def transform(html, base_dir):
    # 1) <link rel="stylesheet" href="local.css"> → <style>…</style>
    def _link(m):
        tag = m.group(0)
        a = _attrs(tag)
        rel = a.get("rel", "").lower()
        href = a.get("href", "")
        if "stylesheet" not in rel or not href or _is_remote(href):
            return tag
        path = _guarded_path(base_dir, href)
        if not path:
            return tag
        raw = _read_bytes(path, href)
        if raw is None:
            return tag
        css = _inline_css(raw.decode("utf-8", "replace"), os.path.dirname(path), 0)
        media = a.get("media", "")
        media_attr = f' media="{media}"' if media else ""
        return f"<style{media_attr}>\n{css}\n</style>"

    html = re.sub(r"<link\b[^>]*>", _link, html, flags=re.IGNORECASE)

    # 2) <style>…</style> — inline url()/@import inside author styles too
    def _style(m):
        return m.group(1) + _inline_css(m.group(2), base_dir, 0) + m.group(3)

    html = re.sub(
        r"(<style\b[^>]*>)(.*?)(</style>)",
        _style,
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )

    # 3) <script src="local.js"></script> → <script>…</script>
    def _script(m):
        open_tag, close_tag = m.group(1), m.group(3)
        a = _attrs(open_tag)
        src = a.get("src", "")
        if not src or _is_remote(src):
            return m.group(0)
        path = _guarded_path(base_dir, src)
        if not path:
            return m.group(0)
        raw = _read_bytes(path, src)
        if raw is None:
            return m.group(0)
        code = raw.decode("utf-8", "replace")
        # </script> inside the code would prematurely close the tag — split it.
        code = code.replace("</script", "<\\/script")
        return _drop_attr(open_tag, "src") + code + close_tag

    html = re.sub(
        r"(<script\b[^>]*>)(.*?)(</script>)",
        _script,
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )

    # 4) media & SVG resource attrs → data: URIs
    def _media(m):
        tag = m.group(0)
        a = _attrs(tag)
        # srcset (img/source): rewrite each candidate url
        if "srcset" in a:

            def _srcset(mm):
                out = []
                for cand in mm.group(1).split(","):
                    parts = cand.split()
                    if not parts:
                        continue
                    uri = _data_uri(base_dir, parts[0])
                    parts[0] = uri if uri else parts[0]
                    out.append(" ".join(parts))
                return 'srcset="' + ", ".join(out) + '"'

            tag = re.sub(
                r"srcset\s*=\s*\"([^\"]*)\"", _srcset, tag, flags=re.IGNORECASE
            )
            tag = re.sub(
                r"srcset\s*=\s*'([^']*)'",
                lambda mm: _srcset(mm),
                tag,
                flags=re.IGNORECASE,
            )
        for attr in ("src", "href", "xlink:href", "poster", "data"):
            if attr in a:
                uri = _data_uri(base_dir, a[attr])
                if uri is not None:
                    tag = _set_attr(tag, attr, uri)
        return tag

    html = re.sub(
        r"<(img|source|video|audio|track|image|use)\b[^>]*>",
        _media,
        html,
        flags=re.IGNORECASE,
    )

    # 5) inline style="…url()…" attributes on any element
    def _style_attr(m):
        return (
            'style="'
            + _inline_css(m.group(1), base_dir, 0).replace('"', "&quot;")
            + '"'
        )

    html = re.sub(
        r"style\s*=\s*\"([^\"]*url\([^\"]*)\"", _style_attr, html, flags=re.IGNORECASE
    )

    return html


def _scrub_secrets(html):
    pattern = os.environ.get("SECRET_PATTERN", "")
    if not pattern:
        return html
    scrubbed, n = re.subn(pattern, "«redacted»", html)
    if n:
        _warn(
            "secret-scrubbed", "", f"{n} secret-like value(s) redacted from the bundle"
        )
    return scrubbed


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: glimpse_export.py <src.html>\n")
        return 2
    src = sys.argv[1]
    try:
        with open(src, "r", encoding="utf-8", errors="replace") as fh:
            html = fh.read()
    except OSError as exc:
        sys.stderr.write(f"glimpse export: cannot read {src}: {exc}\n")
        return 1
    base_dir = os.path.dirname(os.path.abspath(src))
    out = _scrub_secrets(transform(html, base_dir))
    sys.stdout.write(out)
    for kind, ref, reason in _WARNINGS:
        loc = f" {ref}" if ref else ""
        tail = f" — {reason}" if reason else ""
        sys.stderr.write(f"glimpse export: [{kind}]{loc}{tail}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
