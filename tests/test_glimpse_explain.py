import json
import os
import re as _re
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
import glimpse_explain as gx  # noqa: E402


def good_spec():
    return {
        "scope": "change",
        "title": "Daemon path",
        "architecture": {
            "summary": "x",
            "components": [
                {
                    "id": "daemon",
                    "name": "daemon",
                    "role": "answers",
                    "files": ["bin/glimpse"],
                }
            ],
        },
        "dataflow": {
            "nodes": [
                {"id": "daemon", "label": "daemon"},
                {"id": "proxy", "label": "proxy"},
            ],
            "edges": [{"from": "daemon", "to": "proxy", "label": "POST"}],
        },
        "callstack": {
            "entry": "n1",
            "steps": [
                {
                    "id": "n1",
                    "label": "cmd_daemon()",
                    "file": "bin/glimpse",
                    "lines": "1-9",
                    "lang": "bash",
                    "snippet": "x",
                    "calls": ["n2"],
                },
                {
                    "id": "n2",
                    "label": "answer()",
                    "file": "bin/glimpse",
                    "lines": "10-20",
                    "lang": "bash",
                    "snippet": "y",
                    "calls": [],
                },
            ],
        },
    }


def test_good_spec_passes():
    assert gx.validate(good_spec()) is True


def test_missing_title_fails():
    s = good_spec()
    del s["title"]
    with pytest.raises(gx.SpecError):
        gx.validate(s)


def test_bad_scope_fails():
    s = good_spec()
    s["scope"] = "everything"
    with pytest.raises(gx.SpecError):
        gx.validate(s)


def test_no_views_fails():
    with pytest.raises(gx.SpecError):
        gx.validate({"scope": "change", "title": "t"})


def test_one_view_passes():
    assert (
        gx.validate(
            {
                "scope": "change",
                "title": "t",
                "callstack": {
                    "entry": "n1",
                    "steps": [{"id": "n1", "label": "f", "snippet": "x", "calls": []}],
                },
            }
        )
        is True
    )


def test_bad_id_charset_fails():
    s = good_spec()
    s["callstack"]["steps"][0]["id"] = "n 1"
    with pytest.raises(gx.SpecError):
        gx.validate(s)


def test_reserved_word_id_fails():
    s = good_spec()
    s["callstack"]["steps"][0]["id"] = "end"
    s["callstack"]["entry"] = "end"
    s["callstack"]["steps"][1]["calls"] = []
    s["callstack"]["steps"][0]["calls"] = []
    with pytest.raises(gx.SpecError):
        gx.validate(s)


def test_dangling_call_fails():
    s = good_spec()
    s["callstack"]["steps"][0]["calls"] = ["nope"]
    with pytest.raises(gx.SpecError):
        gx.validate(s)


def test_dangling_entry_fails():
    s = good_spec()
    s["callstack"]["entry"] = "nope"
    with pytest.raises(gx.SpecError):
        gx.validate(s)


def test_entry_with_empty_steps_fails():
    s = good_spec()
    s["callstack"]["entry"] = "n1"
    s["callstack"]["steps"] = []
    with pytest.raises(gx.SpecError):
        gx.validate(s)


def test_dangling_edge_fails():
    s = good_spec()
    s["dataflow"]["edges"][0]["to"] = "nope"
    with pytest.raises(gx.SpecError):
        gx.validate(s)


def test_duplicate_id_fails():
    s = good_spec()
    s["callstack"]["steps"][1]["id"] = "n1"
    with pytest.raises(gx.SpecError):
        gx.validate(s)


def test_short_snippet_unchanged():
    assert gx.truncate_snippet("a\nb\nc") == "a\nb\nc"


def test_long_snippet_truncated_with_marker():
    src = "\n".join("line%d" % i for i in range(500))
    out = gx.truncate_snippet(src)
    assert out.count("\n") <= gx.SNIPPET_MAX_LINES + 1
    assert "truncated — showing 200 of 500 lines" in out


def test_non_string_snippet_becomes_empty():
    assert gx.truncate_snippet(None) == ""


def test_byte_only_cut_marks_exceeded_kb():
    # A single line over 16 KB triggers the byte cap but not the 200-line cap.
    src = "x" * (gx.SNIPPET_MAX_BYTES + 5000)
    out = gx.truncate_snippet(src)
    assert "truncated — exceeded 16 KB" in out
    assert "lines]" not in out  # must NOT claim a bogus line count
    assert len(out.encode("utf-8")) <= gx.SNIPPET_MAX_BYTES + 64


def test_wrap_embeds_escaped_spec_and_is_recoverable():
    s = good_spec()
    s["callstack"]["steps"][0]["snippet"] = 'x = "</script><script>alert(1)</script>"'
    html = gx.wrap_artifact(s, s["title"])
    # The raw HTML must NOT contain a literal closing script for our payload's content.
    assert "\\u003c/script>" in html or "\\u003cscript>" in html  # < was escaped
    # And the embedded JSON is recoverable by a JSON parser (mirrors JSON.parse in the browser).
    m = _re.search(
        r'<script type="application/json" id="glimpse-spec">(.*?)</script>', html, _re.S
    )
    assert m, "spec script tag present"
    recovered = json.loads(m.group(1))
    assert recovered["title"] == s["title"]
    assert recovered["callstack"]["steps"][0]["snippet"].endswith('"')


def test_wrap_has_readable_fallback_body_for_pagetext():
    s = good_spec()
    html = gx.wrap_artifact(s, s["title"])
    assert 'id="glimpse-fallback"' in html
    # daemon pageText strips <script>; the architecture summary must survive in the body.
    after_scripts = _re.sub(r"<script.*?</script>", " ", html, flags=_re.S)
    assert "daemon" in after_scripts  # a component name leaks into visible text


def test_wrap_marks_artifact_kind():
    html = gx.wrap_artifact(good_spec(), "t")
    assert 'id="glimpse-explain"' in html


def test_wrap_escapes_agent_controlled_fallback_fields():
    s = good_spec()
    s["title"] = "<script>alert(1)</script>"
    s["architecture"]["components"][0]["name"] = "<script>alert(1)</script>"
    html = gx.wrap_artifact(s, s["title"])
    fallback = html.split('id="glimpse-fallback"')[1].split("</body>")[0]
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in fallback
    assert "<script>alert(1)</script>" not in fallback


MODULE = os.path.join(os.path.dirname(__file__), "..", "lib", "glimpse_explain.py")


def _run(args, stdin):
    return subprocess.run(
        [sys.executable, MODULE] + args, input=stdin, capture_output=True, text=True
    )


def test_cli_validate_ok():
    r = _run(["validate"], json.dumps(good_spec()))
    assert r.returncode == 0, r.stderr


def test_cli_validate_rejects_with_message():
    bad = good_spec()
    del bad["title"]
    r = _run(["validate"], json.dumps(bad))
    assert r.returncode != 0
    assert "title is required" in r.stderr


def test_cli_wrap_emits_html():
    r = _run(["wrap", "My Title"], json.dumps(good_spec()))
    assert r.returncode == 0, r.stderr
    assert 'id="glimpse-spec"' in r.stdout
