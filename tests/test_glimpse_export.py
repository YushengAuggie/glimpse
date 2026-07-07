import base64
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
import glimpse_export as gx  # noqa: E402

# a 1x1 red PNG
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


@pytest.fixture(autouse=True)
def _reset_warnings():
    gx._WARNINGS.clear()
    yield
    gx._WARNINGS.clear()


def _write(d, name, data):
    path = os.path.join(str(d), name)
    os.makedirs(os.path.dirname(path), exist_ok=True) if os.path.dirname(name) else None
    mode = "wb" if isinstance(data, bytes) else "w"
    with open(path, mode) as fh:
        fh.write(data)
    return path


def test_local_stylesheet_link_inlined(tmp_path):
    _write(tmp_path, "app.css", ".x{color:red}")
    html = '<link rel="stylesheet" href="app.css">'
    out = gx.transform(html, str(tmp_path))
    assert "<style" in out and "color:red" in out
    assert "app.css" not in out


def test_remote_stylesheet_left_as_link(tmp_path):
    html = '<link rel="stylesheet" href="https://cdn.example.com/tw.css">'
    out = gx.transform(html, str(tmp_path))
    assert 'href="https://cdn.example.com/tw.css"' in out
    assert "<style" not in out


def test_local_script_inlined_and_src_dropped(tmp_path):
    _write(tmp_path, "app.js", "console.log(1)")
    html = '<script src="app.js"></script>'
    out = gx.transform(html, str(tmp_path))
    assert "console.log(1)" in out
    assert 'src="app.js"' not in out


def test_remote_script_left_as_link(tmp_path):
    html = '<script src="https://cdn.tailwindcss.com"></script>'
    out = gx.transform(html, str(tmp_path))
    assert 'src="https://cdn.tailwindcss.com"' in out


def test_script_close_tag_in_body_is_escaped(tmp_path):
    _write(tmp_path, "app.js", "var s='</script>';")
    html = '<script src="app.js"></script>'
    out = gx.transform(html, str(tmp_path))
    # the literal </script inside the code must be broken so it can't close the tag
    assert "</script>';" not in out
    assert "<\\/script" in out


def test_img_src_becomes_data_uri(tmp_path):
    _write(tmp_path, "logo.png", _PNG)
    html = '<img src="logo.png">'
    out = gx.transform(html, str(tmp_path))
    assert "data:image/png;base64," in out
    assert 'src="logo.png"' not in out


def test_css_url_and_import_inlined(tmp_path):
    _write(tmp_path, "logo.png", _PNG)
    _write(tmp_path, "more.css", ".y{color:blue}")
    html = "<style>@import 'more.css'; body{background:url(logo.png)}</style>"
    out = gx.transform(html, str(tmp_path))
    assert "color:blue" in out  # @import spliced in
    assert "data:image/png;base64," in out  # url() inlined
    assert "@import" not in out


def test_traversal_outside_dir_refused(tmp_path):
    # a file that exists OUTSIDE the artifact dir must not be inlined
    outside = tmp_path.parent / "secret.css"
    outside.write_text(".secret{}")
    art = tmp_path / "art"
    art.mkdir()
    html = '<link rel="stylesheet" href="../secret.css">'
    out = gx.transform(html, str(art))
    assert ".secret{}" not in out
    assert 'href="../secret.css"' in out  # left unchanged
    assert any(k == "outside-root" for k, _, _ in gx._WARNINGS)


def test_root_absolute_left_as_link(tmp_path):
    html = '<img src="/assets/logo.png">'
    out = gx.transform(html, str(tmp_path))
    assert 'src="/assets/logo.png"' in out
    assert any(k == "root-absolute" for k, _, _ in gx._WARNINGS)


def test_missing_local_asset_left_and_warned(tmp_path):
    html = '<img src="nope.png">'
    out = gx.transform(html, str(tmp_path))
    assert 'src="nope.png"' in out
    assert any(k == "missing" for k, _, _ in gx._WARNINGS)


def test_secret_scrub_over_bundle(tmp_path, monkeypatch):
    token = "ghp_" + "A" * 36
    monkeypatch.setenv("SECRET_PATTERN", r"gh[pousr]_[A-Za-z0-9]{36}")
    out = gx._scrub_secrets(f"<p>{token}</p>")
    assert token not in out
    assert "«redacted»" in out
    assert any(k == "secret-scrubbed" for k, _, _ in gx._WARNINGS)


def test_data_uri_ref_left_untouched(tmp_path):
    html = '<img src="data:image/gif;base64,R0lGOD">'
    out = gx.transform(html, str(tmp_path))
    assert out == html  # already inline, nothing to do


def test_oversized_asset_left_as_link(tmp_path, monkeypatch):
    _write(tmp_path, "big.png", b"\x00" * 2048)
    monkeypatch.setattr(gx, "MAX_ASSET_BYTES", 1024)
    html = '<img src="big.png">'
    out = gx.transform(html, str(tmp_path))
    assert 'src="big.png"' in out
    assert any(k == "too-large" for k, _, _ in gx._WARNINGS)
