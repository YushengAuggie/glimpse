import sys, os, json, pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
import glimpse_explain as gx


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
