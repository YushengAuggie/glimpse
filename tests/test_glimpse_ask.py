import json
import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
import glimpse_ask as gk  # noqa: E402

MODULE = os.path.join(os.path.dirname(__file__), "..", "lib", "glimpse_ask.py")


def good_spec():
    return {
        "prompt": "Approve the migration plan?",
        "intro": "Dual-write for a week, then cut reads over.",
        "fields": [
            {
                "type": "radio",
                "name": "decision",
                "label": "Decision",
                "required": True,
                "options": [
                    {"value": "approve", "label": "Approve", "selected": True},
                    {"value": "reject", "label": "Reject"},
                ],
            },
            {
                "type": "checkbox",
                "name": "safeguards",
                "options": [
                    {"value": "backup", "label": "Snapshot first"},
                    {"value": "offpeak", "label": "Run off-peak"},
                ],
            },
            {
                "type": "select",
                "name": "batch",
                "required": True,
                "options": [
                    {"value": "500", "label": "500"},
                    {"value": "1000", "label": "1,000"},
                ],
            },
            {"type": "text", "name": "note", "placeholder": "e.g. run after 6pm"},
            {"type": "textarea", "name": "details"},
        ],
    }


def test_validate_accepts_good_spec():
    assert gk.validate(good_spec()) is True


@pytest.mark.parametrize(
    "mutate, msg",
    [
        (lambda s: s.pop("fields"), "fields must be a non-empty list"),
        (lambda s: s.update(fields=[]), "fields must be a non-empty list"),
        (
            lambda s: s["fields"].__setitem__(0, {"type": "radio", "name": "x"}),
            "options must be a non-empty list",
        ),
        (
            lambda s: s["fields"].__setitem__(
                0, {"type": "nope", "name": "x", "options": [{"value": "a"}]}
            ),
            "type must be one of",
        ),
        (
            lambda s: s["fields"].__setitem__(0, {"type": "text", "name": "a b"}),
            "must match",
        ),
        (
            lambda s: s["fields"].append({"type": "text", "name": "note"}),
            "duplicate field name",
        ),
        (
            lambda s: s["fields"].__setitem__(
                3, {"type": "text", "name": "note", "options": [{"value": "a"}]}
            ),
            "options not allowed",
        ),
        (
            lambda s: s["fields"][0]["options"].append({"value": "approve"}),
            "duplicate option value",
        ),
        (
            lambda s: s["fields"][0]["options"].append({"label": "no value"}),
            "value must be a non-empty string",
        ),
    ],
)
def test_validate_rejects(mutate, msg):
    spec = good_spec()
    mutate(spec)
    with pytest.raises(gk.SpecError) as e:
        gk.validate(spec)
    assert msg in str(e.value)


def test_wrap_has_accessible_themed_controls():
    html = gk.wrap_artifact(good_spec(), "Approve?")
    # custom (non-native-black-dot) controls that theme both ways
    assert "appearance:none" in html
    assert "prefers-color-scheme: dark" in html
    assert 'name="color-scheme" content="light dark"' in html
    # native controls actually present
    assert html.count('type="radio"') == 2
    assert html.count('type="checkbox"') == 2
    assert "<select" in html and "<textarea" in html
    # the existing return channel — no second mechanism invented
    assert "glimpseRespond" in html
    assert 'type: "glimpse:response"' in html


def test_wrap_wires_required_semantics():
    html = gk.wrap_artifact(good_spec(), "T")
    # required radio → native `required` on the input; required checkbox → data-min
    assert "<input required" in html
    # required select → placeholder option so "nothing chosen" is invalid
    assert 'value="" disabled selected' in html
    # checkbox group here is NOT required, so no data-min unless we set it
    spec = good_spec()
    spec["fields"][1]["required"] = True
    assert 'data-min="1"' in gk.wrap_artifact(spec, "T")


def test_wrap_escapes_html_in_labels():
    spec = good_spec()
    spec["fields"][0]["options"][0]["label"] = "</script><img src=x onerror=alert(1)>"
    spec["prompt"] = "<b>hi</b>"
    html = gk.wrap_artifact(spec, "<title>")
    assert "<img src=x" not in html
    assert "&lt;img src=x" in html
    # no raw </script> from user data can break out of our inline <script>
    body_before_script = html.rsplit("<script>", 1)[0]
    assert "</script>" not in body_before_script


def _run(subcmd, spec_text):
    p = subprocess.run(
        [sys.executable, MODULE, subcmd],
        input=spec_text,
        capture_output=True,
        text=True,
    )
    return p.returncode, p.stdout, p.stderr


def test_cli_exit_codes():
    rc, out, _ = _run("wrap", json.dumps(good_spec()))
    assert rc == 0 and "<!doctype html>" in out
    rc, _, err = _run("validate", json.dumps({"fields": []}))
    assert rc == 2 and "non-empty list" in err
    rc, _, err = _run("validate", "not json")
    assert rc == 2 and "not valid JSON" in err
