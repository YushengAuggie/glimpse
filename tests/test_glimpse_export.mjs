// Port of tests/test_glimpse_export.py — white-box unit tests for the offline
// asset inliner, now exercising the Node module lib/glimpse-export.mjs.
// Runs under `node --test`. Mirrors the pytest file case-for-case.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { transform, scrubSecrets, _WARNINGS } from "../lib/glimpse-export.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.resolve(__dirname, "..", "lib", "glimpse-export.mjs");

// a 1x1 red PNG (same bytes as the Python test's _PNG)
const _PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// autouse fixture equivalent: clear _WARNINGS before and after every test.
beforeEach(() => {
  _WARNINGS.length = 0;
});
afterEach(() => {
  _WARNINGS.length = 0;
});

// Fresh temp dir per test (like pytest's tmp_path). Mirrors the Python _write:
// creates parent dirs for nested names, writes bytes or text.
function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glimpse-exp-"));
}

function _write(d, name, data) {
  const p = path.join(d, name);
  if (path.dirname(name) !== ".") {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  }
  fs.writeFileSync(p, data);
  return p;
}

test("local_stylesheet_link_inlined", () => {
  const d = mkTmp();
  _write(d, "app.css", ".x{color:red}");
  const html = '<link rel="stylesheet" href="app.css">';
  const out = transform(html, d);
  assert.ok(out.includes("<style") && out.includes("color:red"));
  assert.ok(!out.includes("app.css"));
});

test("remote_stylesheet_left_as_link", () => {
  const d = mkTmp();
  const html = '<link rel="stylesheet" href="https://cdn.example.com/tw.css">';
  const out = transform(html, d);
  assert.ok(out.includes('href="https://cdn.example.com/tw.css"'));
  assert.ok(!out.includes("<style"));
});

test("local_script_inlined_and_src_dropped", () => {
  const d = mkTmp();
  _write(d, "app.js", "console.log(1)");
  const html = '<script src="app.js"></script>';
  const out = transform(html, d);
  assert.ok(out.includes("console.log(1)"));
  assert.ok(!out.includes('src="app.js"'));
});

test("remote_script_left_as_link", () => {
  const d = mkTmp();
  const html = '<script src="https://cdn.tailwindcss.com"></script>';
  const out = transform(html, d);
  assert.ok(out.includes('src="https://cdn.tailwindcss.com"'));
});

test("script_close_tag_in_body_is_escaped", () => {
  const d = mkTmp();
  _write(d, "app.js", "var s='</script>';");
  const html = '<script src="app.js"></script>';
  const out = transform(html, d);
  // the literal </script inside the code must be broken so it can't close the tag
  assert.ok(!out.includes("</script>';"));
  // "<\\/script" in a JS string literal is the 8 chars: < \ / s c r i p t
  assert.ok(out.includes("<\\/script"));
});

test("img_src_becomes_data_uri", () => {
  const d = mkTmp();
  _write(d, "logo.png", _PNG);
  const html = '<img src="logo.png">';
  const out = transform(html, d);
  assert.ok(out.includes("data:image/png;base64,"));
  assert.ok(!out.includes('src="logo.png"'));
});

test("css_url_and_import_inlined", () => {
  const d = mkTmp();
  _write(d, "logo.png", _PNG);
  _write(d, "more.css", ".y{color:blue}");
  const html = "<style>@import 'more.css'; body{background:url(logo.png)}</style>";
  const out = transform(html, d);
  assert.ok(out.includes("color:blue")); // @import spliced in
  assert.ok(out.includes("data:image/png;base64,")); // url() inlined
  assert.ok(!out.includes("@import"));
});

test("traversal_outside_dir_refused", () => {
  const d = mkTmp();
  // a file that exists OUTSIDE the artifact dir must not be inlined
  fs.writeFileSync(path.join(d, "secret.css"), ".secret{}");
  const art = path.join(d, "art");
  fs.mkdirSync(art);
  const html = '<link rel="stylesheet" href="../secret.css">';
  const out = transform(html, art);
  assert.ok(!out.includes(".secret{}"));
  assert.ok(out.includes('href="../secret.css"')); // left unchanged
  assert.ok(_WARNINGS.some((w) => w[0] === "outside-root"));
});

test("root_absolute_left_as_link", () => {
  const d = mkTmp();
  const html = '<img src="/assets/logo.png">';
  const out = transform(html, d);
  assert.ok(out.includes('src="/assets/logo.png"'));
  assert.ok(_WARNINGS.some((w) => w[0] === "root-absolute"));
});

test("missing_local_asset_left_and_warned", () => {
  const d = mkTmp();
  const html = '<img src="nope.png">';
  const out = transform(html, d);
  assert.ok(out.includes('src="nope.png"'));
  assert.ok(_WARNINGS.some((w) => w[0] === "missing"));
});

test("secret_scrub_over_bundle", () => {
  const token = "ghp_" + "A".repeat(36);
  const prev = process.env.SECRET_PATTERN;
  process.env.SECRET_PATTERN = "gh[pousr]_[A-Za-z0-9]{36}";
  try {
    const out = scrubSecrets(`<p>${token}</p>`);
    assert.ok(!out.includes(token));
    assert.ok(out.includes("«redacted»"));
    assert.ok(_WARNINGS.some((w) => w[0] === "secret-scrubbed"));
  } finally {
    if (prev === undefined) delete process.env.SECRET_PATTERN;
    else process.env.SECRET_PATTERN = prev;
  }
});

test("data_uri_ref_left_untouched", () => {
  const d = mkTmp();
  const html = '<img src="data:image/gif;base64,R0lGOD">';
  const out = transform(html, d);
  assert.equal(out, html); // already inline, nothing to do
});

// The MAX_ASSET_BYTES cap is a module-load `const` read from
// GLIMPSE_EXPORT_MAX_ASSET_BYTES; it cannot be reassigned at runtime the way the
// pytest test monkeypatches gx.MAX_ASSET_BYTES. So we run this one case in a
// dedicated child process with the env var set to 1024 BEFORE the module loads,
// and assert on the child's printed verdict.
test("oversized_asset_left_as_link", () => {
  const d = mkTmp();
  _write(d, "big.png", Buffer.alloc(2048, 0));
  const script = `
    import { transform, _WARNINGS } from ${JSON.stringify(MODULE)};
    const out = transform('<img src="big.png">', ${JSON.stringify(d)});
    const leftAsLink = out.includes('src="big.png"');
    const tooLarge = _WARNINGS.some((w) => w[0] === "too-large");
    process.stdout.write(JSON.stringify({ leftAsLink, tooLarge }));
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, GLIMPSE_EXPORT_MAX_ASSET_BYTES: "1024" },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, `child failed: ${res.stderr}`);
  const verdict = JSON.parse(res.stdout);
  assert.ok(verdict.leftAsLink);
  assert.ok(verdict.tooLarge);
});
