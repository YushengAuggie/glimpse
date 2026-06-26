#!/usr/bin/env python3
"""Glimpse code-explainer engine: validate an explain spec and wrap it into an
artifact. Imported by tests and invoked as a CLI by `bin/glimpse`. Stdlib only."""

import json
import re
import sys

SCOPES = {"change", "feature", "repo"}
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MERMAID_RESERVED = {
    "end",
    "default",
    "graph",
    "flowchart",
    "subgraph",
    "classDef",
    "linkStyle",
    "style",
    "click",
}
SNIPPET_MAX_LINES = 200
SNIPPET_MAX_BYTES = 16 * 1024
SPEC_MAX_BYTES = 2 * 1024 * 1024


class SpecError(ValueError):
    """Raised on the first validation problem, with a human-readable message."""


def _check_ids(items, where):
    if not isinstance(items, list):
        raise SpecError("%s must be a list" % where)
    seen = set()
    for it in items:
        i = it.get("id") if isinstance(it, dict) else None
        if not isinstance(i, str) or not ID_RE.match(i):
            raise SpecError("%s: id %r must match [A-Za-z0-9_-]{1,64}" % (where, i))
        if i in MERMAID_RESERVED:
            raise SpecError("%s: id %r is a reserved word" % (where, i))
        if i in seen:
            raise SpecError("%s: duplicate id %r" % (where, i))
        seen.add(i)
    return seen


def validate(spec):
    """Validate a parsed spec dict. Return True or raise SpecError(msg)."""
    if not isinstance(spec, dict):
        raise SpecError("spec must be a JSON object")
    if spec.get("scope") not in SCOPES:
        raise SpecError("scope must be one of: change, feature, repo")
    if not isinstance(spec.get("title"), str) or not spec["title"].strip():
        raise SpecError("title is required")
    if not any(spec.get(k) for k in ("architecture", "dataflow", "callstack")):
        raise SpecError(
            "at least one of architecture/dataflow/callstack must be present"
        )

    arch = spec.get("architecture") or {}
    _check_ids(arch.get("components", []), "architecture.components")

    df = spec.get("dataflow") or {}
    df_ids = _check_ids(df.get("nodes", []), "dataflow.nodes")
    edges = df.get("edges", [])
    if not isinstance(edges, list):
        raise SpecError("dataflow.edges must be a list")
    for e in edges:
        for end in ("from", "to"):
            if e.get(end) not in df_ids:
                raise SpecError(
                    "dataflow.edges: %s references unknown node %r" % (end, e.get(end))
                )

    cs = spec.get("callstack") or {}
    step_ids = _check_ids(cs.get("steps", []), "callstack.steps")
    if cs.get("entry") is not None and cs.get("entry") not in step_ids:
        raise SpecError("callstack.entry %r is not a declared step" % cs.get("entry"))
    for st in cs.get("steps", []):
        calls = st.get("calls") or []
        if not isinstance(calls, list):
            raise SpecError("callstack.steps[%s].calls must be a list" % st.get("id"))
        for c in calls:
            if c not in step_ids:
                raise SpecError(
                    "callstack.steps[%s].calls references unknown step %r"
                    % (st.get("id"), c)
                )
    return True


def truncate_snippet(text):
    """Cap a snippet to SNIPPET_MAX_LINES / SNIPPET_MAX_BYTES; append a marker if cut."""
    if not isinstance(text, str):
        return ""
    lines = text.split("\n")
    total = len(lines)
    line_cut = False
    if total > SNIPPET_MAX_LINES:
        lines = lines[:SNIPPET_MAX_LINES]
        line_cut = True
    out = "\n".join(lines)
    byte_cut = False
    if len(out.encode("utf-8")) > SNIPPET_MAX_BYTES:
        out = out.encode("utf-8")[:SNIPPET_MAX_BYTES].decode("utf-8", "ignore")
        byte_cut = True
    if line_cut and byte_cut:
        # Both caps fired: report the lines that actually survived the byte trim.
        surviving = out.count("\n") + 1
        out += "\n// … [truncated — showing %d of %d lines, %d KB cap]" % (
            surviving,
            total,
            SNIPPET_MAX_BYTES // 1024,
        )
    elif line_cut:
        out += "\n// … [truncated — showing %d of %d lines]" % (
            SNIPPET_MAX_LINES,
            total,
        )
    elif byte_cut:
        out += "\n// … [truncated — exceeded %d KB]" % (SNIPPET_MAX_BYTES // 1024)
    return out


def _html_escape(s):
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _escape_for_script(json_text):
    """Make a JSON string safe inside <script>…</script>: escape every '<' as the
    JSON unicode escape \\u003c. No '</script>' or '<!--' can survive, and a JSON
    parser (json.loads / browser JSON.parse) decodes it back losslessly."""
    return json_text.replace("<", "\\u003c")


def _apply_truncation(spec):
    for st in (spec.get("callstack") or {}).get("steps", []):
        if isinstance(st, dict) and "snippet" in st:
            st["snippet"] = truncate_snippet(st.get("snippet"))
    return spec


def _readable_body(spec, title):
    """A plain, visible fallback the daemon's pageText() can read (it strips <script>).
    The renderer (Plan 2) hides #glimpse-fallback once it mounts."""
    parts = ['<div id="glimpse-fallback"><h1>%s</h1>' % _html_escape(title)]
    arch = spec.get("architecture") or {}
    if arch.get("summary"):
        parts.append("<p>%s</p>" % _html_escape(arch["summary"]))
    for c in arch.get("components", []):
        parts.append(
            "<p><b>%s</b> — %s</p>"
            % (_html_escape(c.get("name", "")), _html_escape(c.get("role", "")))
        )
        if c.get("note"):
            parts.append("<p>%s</p>" % _html_escape(c["note"]))
    for st in (spec.get("callstack") or {}).get("steps", []):
        parts.append(
            "<p><code>%s</code> (%s)</p>"
            % (_html_escape(st.get("label", "")), _html_escape(st.get("file", "")))
        )
        if st.get("note"):
            parts.append("<p>%s</p>" % _html_escape(st["note"]))
    parts.append("</div>")
    return "".join(parts)


def wrap_artifact(spec, title):
    """Return artifact HTML: a renderer mount point, a readable fallback body, and the
    spec embedded as </script>-safe JSON."""
    spec = _apply_truncation(spec)
    payload = _escape_for_script(json.dumps(spec, ensure_ascii=False))
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        "<title>%s</title></head><body>"
        '<div id="glimpse-explain"></div>'
        "%s"
        '<script type="application/json" id="glimpse-spec">%s</script>'
        "</body></html>"
    ) % (_html_escape(title), _readable_body(spec, title), payload)


def _main(argv):
    if not argv:
        sys.stderr.write("usage: glimpse_explain.py validate|wrap <title>\n")
        return 2
    cmd = argv[0]
    try:
        spec = json.load(sys.stdin)
    except Exception as e:
        sys.stderr.write("glimpse explain: spec is not valid JSON: %s\n" % e)
        return 2
    raw = json.dumps(spec, ensure_ascii=False)
    if len(raw.encode("utf-8")) > SPEC_MAX_BYTES:
        sys.stderr.write("glimpse explain: spec exceeds %d bytes\n" % SPEC_MAX_BYTES)
        return 2
    try:
        validate(spec)
    except SpecError as e:
        sys.stderr.write("glimpse explain: %s\n" % e)
        return 2
    if cmd == "validate":
        return 0
    if cmd == "wrap":
        title = argv[1] if len(argv) > 1 else spec.get("title", "Explain")
        sys.stdout.write(wrap_artifact(spec, title))
        return 0
    sys.stderr.write("glimpse explain: unknown subcommand %r\n" % cmd)
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
