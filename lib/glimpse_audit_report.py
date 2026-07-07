#!/usr/bin/env python3
"""glimpse_audit_report.py — turn a captured layout audit into human output.

The auditor (canvas/glimpse-audit.js) runs in the artifact iframe and posts
findings up to the canvas shell, where they land as `window.__glimpse_audit`.
`bin/glimpse`'s `_audit_capture` reads that object over CDP and pipes the raw
JSON here so both the standalone `glimpse audit` verb and the auto-audit-on-
publish path share ONE renderer instead of two drifting `console.log` blocks.

Input : the audit JSON object on stdin (or empty / "null" when the auditor
        never reported — e.g. annotate disabled). Shape:
          {slug, viewportWidth, errors, warnings, findings:[{selector,kind,
           overflowPx,severity}], ts}
Env   : MODE = "full" (the detailed `glimpse audit` report) | "brief" (a single
        concise line for publish); SLUG (fallback slug for the header/summary).
Output: the report on stdout. `brief` prints NOTHING when the artifact is clean,
        so a good layout stays quiet.
Exit  : 2 when any error-severity finding is present, else 0 — the single source
        of truth the caller reads to decide the audit gate.

Severity/finding vocabulary is owned by glimpse-audit.js; this module only
formats and counts, so audit rules stay in one place.
"""

import json
import os
import sys

# kind → friendlier phrase for the one-line publish summary. Unknown kinds fall
# back to the raw kind so a new rule in glimpse-audit.js still reads sensibly.
_PHRASE = {
    "page-horizontal-overflow": "horizontal overflow",
    "element-overflow": "content overflow",
    "clipped-text": "clipped text",
    "overlapping-text": "overlapping text",
}
_BRIEF_LIST = 3  # findings named inline in the brief line before "+N more"


def _load(raw):
    raw = (raw or "").strip()
    if not raw or raw == "null":
        return None
    try:
        obj = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return obj if isinstance(obj, dict) else None


def _findings(audit):
    f = audit.get("findings")
    return [x for x in f if isinstance(x, dict)] if isinstance(f, list) else []


def _split(findings):
    err = [x for x in findings if x.get("severity") == "error"]
    warn = [x for x in findings if x.get("severity") != "error"]
    return err, warn


def _px(x):
    n = x.get("overflowPx")
    return "  (+%spx)" % n if n else ""


def _full(audit, slug):
    findings = _findings(audit)
    err, warn = _split(findings)
    vw = audit.get("viewportWidth")
    lines = [
        "glimpse audit %s @ %spx viewport — %d error, %d warning"
        % (slug, vw, len(err), len(warn))
    ]
    for x in findings:
        lines.append(
            "  [%s] %s  %s%s"
            % (x.get("severity"), x.get("kind"), x.get("selector"), _px(x))
        )
    # compact machine line (same keys/order the verb has always emitted), so any
    # downstream JSON consumer of `glimpse audit` keeps working.
    lines.append(
        json.dumps(
            {
                "slug": slug,
                "viewportWidth": vw,
                "errors": len(err),
                "warnings": len(warn),
                "findings": findings,
            },
            separators=(",", ":"),
        )
    )
    return "\n".join(lines), (2 if err else 0)


def _brief(audit, slug):
    findings = _findings(audit)
    if not findings:
        return "", 0  # clean artifact → stay silent
    err, _ = _split(findings)
    named = []
    for x in findings[:_BRIEF_LIST]:
        phrase = _PHRASE.get(x.get("kind"), x.get("kind"))
        named.append("%s in %s%s" % (phrase, x.get("selector"), _px(x)))
    more = len(findings) - _BRIEF_LIST
    if more > 0:
        named.append("+%d more" % more)
    n = len(findings)
    line = "⚠ glimpse: %d layout issue%s in %s — %s — run: glimpse audit %s" % (
        n,
        "" if n == 1 else "s",
        slug,
        "; ".join(named),
        slug,
    )
    return line, (2 if err else 0)


def main():
    mode = os.environ.get("MODE", "full")
    slug = os.environ.get("SLUG", "")
    audit = _load(sys.stdin.read())
    if audit is None:
        # No audit reported. `full` callers print their own "no audit" note
        # before invoking us, so emit nothing and succeed either way.
        return 0
    if not slug:
        slug = audit.get("slug", "")
    out, code = _brief(audit, slug) if mode == "brief" else _full(audit, slug)
    if out:
        print(out)
    return code


if __name__ == "__main__":
    sys.exit(main())
