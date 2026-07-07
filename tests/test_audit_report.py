"""Unit tests for lib/glimpse_audit_report.py — the shared renderer that both
`glimpse audit` (full) and auto-audit-on-publish (brief) drive. Invoked as a
subprocess so the tests also lock in the EXIT CODE the audit gate reads."""

import json
import os
import subprocess
import sys

LIB = os.path.join(os.path.dirname(__file__), "..", "lib", "glimpse_audit_report.py")


def run(audit, mode="full", slug="demo"):
    raw = "" if audit is None else json.dumps(audit)
    env = dict(os.environ, MODE=mode, SLUG=slug)
    p = subprocess.run(
        [sys.executable, LIB],
        input=raw,
        env=env,
        capture_output=True,
        text=True,
    )
    return p.returncode, p.stdout


def audit(findings, vw=1000):
    return {
        "slug": "demo",
        "viewportWidth": vw,
        "errors": sum(1 for f in findings if f.get("severity") == "error"),
        "warnings": sum(1 for f in findings if f.get("severity") != "error"),
        "findings": findings,
        "ts": 123,
    }


OVERFLOW = {
    "selector": "div.foo",
    "kind": "element-overflow",
    "overflowPx": 40,
    "severity": "error",
}
CLIPPED = {
    "selector": "span.bar",
    "kind": "clipped-text",
    "overflowPx": 570,
    "severity": "error",
}
WARN = {
    "selector": "p.x",
    "kind": "element-overflow",
    "overflowPx": 3,
    "severity": "warning",
}


# --- brief mode (publish auto-audit) ----------------------------------------


def test_brief_clean_is_silent_and_zero_exit():
    code, out = run(audit([]), mode="brief")
    assert out == ""
    assert code == 0


def test_brief_no_audit_is_silent_and_zero_exit():
    # empty stdin (auditor never reported, e.g. annotate off) must not fail.
    code, out = run(None, mode="brief")
    assert out == ""
    assert code == 0
    # a literal "null" (window.__glimpse_audit === null) is also silent.
    p = subprocess.run(
        [sys.executable, LIB],
        input="null",
        env=dict(os.environ, MODE="brief", SLUG="demo"),
        capture_output=True,
        text=True,
    )
    assert p.stdout == "" and p.returncode == 0


def test_brief_lists_issues_and_points_to_audit():
    code, out = run(audit([OVERFLOW, CLIPPED]), mode="brief")
    assert code == 2  # error-severity present
    assert "2 layout issues in demo" in out
    assert "content overflow in div.foo  (+40px)" in out
    assert "clipped text in span.bar" in out
    assert "run: glimpse audit demo" in out
    assert out.startswith("⚠")


def test_brief_singular_and_truncates_with_more():
    many = [dict(OVERFLOW, selector="div.n%d" % i) for i in range(5)]
    code, out = run(audit(many), mode="brief")
    assert "5 layout issues" in out
    assert "+2 more" in out  # 5 findings, 3 named
    code, out = run(audit([OVERFLOW]), mode="brief")
    assert "1 layout issue in demo" in out  # singular, no "s"


def test_brief_warning_only_findings_do_not_gate():
    code, out = run(audit([WARN]), mode="brief")
    assert out != ""  # still surfaced as a warning
    assert code == 0  # but no error → gate stays clean


# --- full mode (standalone `glimpse audit`) ---------------------------------


def test_full_header_and_finding_lines():
    code, out = run(audit([OVERFLOW]), mode="full")
    lines = out.splitlines()
    assert lines[0] == "glimpse audit demo @ 1000px viewport — 1 error, 0 warning"
    assert lines[1] == "  [error] element-overflow  div.foo  (+40px)"
    assert code == 2


def test_full_emits_compact_machine_json_last():
    code, out = run(audit([OVERFLOW, WARN]), mode="full")
    last = out.splitlines()[-1]
    obj = json.loads(last)
    assert obj["slug"] == "demo"
    assert obj["errors"] == 1 and obj["warnings"] == 1
    assert obj["viewportWidth"] == 1000
    assert len(obj["findings"]) == 2
    assert " " not in last  # compact, no spaces
    assert code == 2


def test_full_clean_exits_zero():
    code, out = run(audit([]), mode="full")
    assert out.splitlines()[0].endswith("0 error, 0 warning")
    assert code == 0
