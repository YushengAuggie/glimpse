// Guards the canvas shell's light/dark theming (canvas/index.html). Pure disk
// read + assertions — no browser. The full render is verified via chrome-devtools
// during development; this locks in the structural contract so it can't silently
// regress: light-default tokens, dark under BOTH the OS media query and an explicit
// [data-theme="dark"], the pre-paint head script, and the __applyTheme entry point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'canvas', 'index.html'), 'utf8');

test('html opts into light+dark and defaults to auto', () => {
  assert.match(html, /<html lang="en" data-theme="auto">/);
  assert.match(html, /color-scheme:\s*light dark/);
});

test('a pre-paint head script applies the saved theme before first paint', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  // The theme-applying script must live in <head> (before the body renders) so
  // there is no flash of the wrong theme.
  assert.match(head, /localStorage\.getItem\('glimpse-theme'\)/);
  assert.match(head, /setAttribute\('data-theme'/);
});

test(':root is the light palette (indigo accent, off-white bg, ink text)', () => {
  const root = html.match(/:root\s*\{[^}]*\}/);
  assert.ok(root, ':root token block present');
  assert.match(root[0], /--accent:#4c5fd5/);   // base.html light indigo
  assert.match(root[0], /--bg:#f6f7fb/);        // soft off-white
  assert.match(root[0], /--text:#1a1b26/);      // ink
});

test('dark applies under BOTH the OS media query and an explicit toggle', () => {
  // Media query: dark unless the user explicitly chose light (explicit light beats OS).
  assert.match(html, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/);
  // Explicit toggle: dark always wins.
  assert.match(html, /:root\[data-theme="dark"\]\s*\{/);
  // Both dark blocks restore the original dark bg.
  const darkBgs = html.match(/--bg:#0f1115/g) || [];
  assert.ok(darkBgs.length >= 2, 'dark --bg defined in media + explicit blocks');
});

test('badge/flash/annpill colors are tokenized (no hardcoded dark hex that breaks light)', () => {
  // These used to be hardcoded dark-tinted hex that were illegible in light mode.
  assert.match(html, /\.badge\.await\s*\{\s*background:var\(--await-bg\);\s*color:var\(--await-ink\);/);
  assert.match(html, /\.badge\.done\s*\{\s*background:var\(--done-bg\);\s*color:var\(--done-ink\);/);
  assert.match(html, /background:var\(--flash-bg\)/);
  assert.match(html, /\.annpill\.live\s*\{[^}]*border-color:var\(--live-line\)/);
  assert.match(html, /\.annpill\.down\s*\{[^}]*border-color:var\(--down-line\)/);
  // No leftover raw dark badge/flash hex outside the token declarations.
  assert.doesNotMatch(html, /background:#3a2e15/);
  assert.doesNotMatch(html, /background:#22301f/);
});

test('a theme toggle iconbtn lives in the header with the shared __applyTheme entry point', () => {
  assert.match(html, /<button id="themetog" class="iconbtn"[^>]*aria-pressed=/);
  assert.match(html, /window\.__applyTheme\s*=\s*function/);
  // aria-label + icon name the mode you switch TO (control doubles as its action).
  assert.match(html, /'Switch to light theme'\s*:\s*'Switch to dark theme'/);
});
