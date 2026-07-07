// glimpse-export.mjs — inline a published artifact's LOCAL assets into one
// portable, self-contained HTML document, invoked as a CLI by `bin/glimpse`.
// Node stdlib only. Port of the former glimpse_export.py (byte-for-byte behavior).
//
//   node glimpse-export.mjs <src.html>
//
// Reads the artifact at <src.html>, inlines every asset it references by a *local*
// relative path — stylesheets, scripts, images, fonts, and url(...) refs inside CSS
// — as inline <style>/<script> or data: URIs, so the result opens in any browser
// with no Glimpse server and no sibling files. Prints the bundled HTML to stdout;
// one warning per un-inlinable ref to stderr.
//
// Deliberately left as network links (this is a feature — do NOT vendor them):
//   - absolute URLs (https://, http://), protocol-relative (//cdn…), data:, blob:,
//     mailto:/tel:, and in-page anchors (#…). A Mermaid or Tailwind CDN <script>/<link>
//     loads over the network, exactly as it did on the canvas.
//   - root-absolute paths (/foo.css): a portable file has no server root to resolve
//     them against, so they are left unchanged with a warning.
//
// Security posture (mirrors the rest of glimpse):
//   - File reads are CONFINED to the artifact's own directory. A ref that resolves
//     (via ../ or a symlink) outside that directory is refused and left unchanged.
//   - The final bundle is scrubbed against SECRET_PATTERN (env, shared with the
//     thread/secret guard): anything matching is replaced with «redacted».

import fs from "node:fs";
import path from "node:path";

// Assets larger than this are left as links rather than inlined, so a stray huge
// file can't blow the bundle up. Override with GLIMPSE_EXPORT_MAX_ASSET_BYTES.
const MAX_ASSET_BYTES = parseInt(
  process.env.GLIMPSE_EXPORT_MAX_ASSET_BYTES || String(8 * 1024 * 1024),
  10,
);
// @import / url() recursion in CSS is bounded so a cyclic import can't spin forever.
const MAX_CSS_DEPTH = 8;

// Extensions the stdlib mime table misses or gets wrong for the web fonts /
// image types artifacts commonly reference.
const EXTRA_MIME = {
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
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".json": "application/json",
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

export const _WARNINGS = [];

function _warn(kind, ref, reason = "") {
  _WARNINGS.push([kind, ref, reason]);
}

// A ref we deliberately leave as a network/opaque link (never inline).
function isRemote(ref) {
  const r = (ref || "").trim();
  if (!r) return true;
  // scheme:// , protocol-relative, data/blob/mailto/tel, in-page anchor
  return Boolean(
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(r) || r.startsWith("//") || r.startsWith("#"),
  );
}

// Resolve a local ref under base_dir, refusing anything that escapes it. Strips
// any ?query / #fragment first (asset refs may carry a cache-buster). Returns an
// absolute path inside base_dir, or null if it can't/shouldn't be read.
function guardedPath(baseDir, ref) {
  const clean = ref.split(/[?#]/, 1)[0];
  if (!clean) return null;
  if (clean.startsWith("/")) {
    _warn("root-absolute", ref, "no server root in a portable file — left as a link");
    return null;
  }
  let base;
  try {
    base = fs.realpathSync(baseDir);
  } catch {
    base = path.resolve(baseDir);
  }
  let target = path.resolve(base, clean);
  try {
    target = fs.realpathSync(target);
  } catch {
    // file may not exist yet / broken symlink — fall through to isFile check
  }
  if (target !== base && !target.startsWith(base + path.sep)) {
    _warn("outside-root", ref, "resolves outside the artifact directory — refused");
    return null;
  }
  let st;
  try {
    st = fs.statSync(target);
  } catch {
    _warn("missing", ref, "file not found next to the artifact");
    return null;
  }
  if (!st.isFile()) {
    _warn("missing", ref, "file not found next to the artifact");
    return null;
  }
  return target;
}

function mimeFor(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext in EXTRA_MIME) return EXTRA_MIME[ext];
  return "application/octet-stream";
}

function readBytes(p, ref) {
  let size;
  try {
    size = fs.statSync(p).size;
  } catch {
    _warn("missing", ref, "could not stat file");
    return null;
  }
  if (size > MAX_ASSET_BYTES) {
    _warn("too-large", ref, `${size} bytes > ${MAX_ASSET_BYTES} limit — left as a link`);
    return null;
  }
  try {
    return fs.readFileSync(p);
  } catch (exc) {
    _warn("load-failed", ref, String(exc && exc.message ? exc.message : exc));
    return null;
  }
}

// A data: URI for a local ref, or null to leave the ref unchanged.
function dataUri(baseDir, ref) {
  if (isRemote(ref)) return null;
  const p = guardedPath(baseDir, ref);
  if (!p) return null;
  const raw = readBytes(p, ref);
  if (raw === null) return null;
  const mime = mimeFor(p);
  return `data:${mime};base64,${raw.toString("base64")}`;
}

// Decode bytes as UTF-8 with lossy replacement (matches Python errors="replace").
function decodeUtf8(buf) {
  return new TextDecoder("utf-8").decode(buf);
}

// --- CSS: inline url(...) refs and @import, relative to the CSS file's dir ---

function inlineCss(css, cssDir, depth) {
  if (depth > MAX_CSS_DEPTH) {
    _warn("css-depth", cssDir, "@import nesting too deep — stopped inlining");
    return css;
  }

  // @import "x.css";  /  @import url("x.css") screen;  — splice the imported
  // sheet in place (recursively) so the bundle needs no sibling CSS.
  const importRe =
    /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)([^;]*);/g;
  css = css.replace(importRe, (full, _q1, urlRef, _q2, bareRef, media) => {
    const ref = urlRef || bareRef;
    if (!ref || isRemote(ref)) return full;
    const p = guardedPath(cssDir, ref);
    if (!p) return full;
    const raw = readBytes(p, ref);
    if (raw === null) return full;
    const m = (media || "").trim();
    const inner = inlineCss(decodeUtf8(raw), path.dirname(p), depth + 1);
    return m ? `@media ${m}{${inner}}` : inner;
  });

  // url(...) — fonts, background images, etc.
  const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  css = css.replace(urlRe, (full, quote, ref) => {
    const uri = dataUri(cssDir, ref);
    if (uri === null) return full;
    const q = quote || "";
    return `url(${q}${uri}${q})`;
  });
  return css;
}

// --- HTML tag rewriting (pragmatic regex over generated, well-formed HTML) ---

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;

function parseAttrs(tagInner) {
  const out = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(tagInner)) !== null) {
    const val = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
    out[m[1].toLowerCase()] = val || "";
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replace name="…"/name='…' in a raw tag string, preserving nothing (always
// re-quotes with "). count=1 semantics.
function setAttr(tag, name, value) {
  const pat = new RegExp(
    "(\\b" + escapeRe(name) + "\\s*=\\s*)(\"[^\"]*\"|'[^']*'|[^\\s>]+)",
    "i",
  );
  let done = false;
  return tag.replace(pat, (full, p1) => {
    if (done) return full;
    done = true;
    return p1 + '"' + value + '"';
  });
}

function dropAttr(tag, name) {
  const pat = new RegExp(
    "\\s+" + escapeRe(name) + "\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)",
    "i",
  );
  let done = false;
  return tag.replace(pat, (full) => {
    if (done) return full;
    done = true;
    return "";
  });
}

export function transform(html, baseDir) {
  // 1) <link rel="stylesheet" href="local.css"> → <style>…</style>
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const a = parseAttrs(tag);
    const rel = (a.rel || "").toLowerCase();
    const href = a.href || "";
    if (!rel.includes("stylesheet") || !href || isRemote(href)) return tag;
    const p = guardedPath(baseDir, href);
    if (!p) return tag;
    const raw = readBytes(p, href);
    if (raw === null) return tag;
    const css = inlineCss(decodeUtf8(raw), path.dirname(p), 0);
    const media = a.media || "";
    const mediaAttr = media ? ` media="${media}"` : "";
    return `<style${mediaAttr}>\n${css}\n</style>`;
  });

  // 2) <style>…</style> — inline url()/@import inside author styles too
  html = html.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (full, open, body, close) => open + inlineCss(body, baseDir, 0) + close,
  );

  // 3) <script src="local.js"></script> → <script>…</script>
  html = html.replace(
    /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (full, openTag, _body, closeTag) => {
      const a = parseAttrs(openTag);
      const src = a.src || "";
      if (!src || isRemote(src)) return full;
      const p = guardedPath(baseDir, src);
      if (!p) return full;
      const raw = readBytes(p, src);
      if (raw === null) return full;
      let code = decodeUtf8(raw);
      // </script> inside the code would prematurely close the tag — split it.
      code = code.replace(/<\/script/g, "<\\/script");
      return dropAttr(openTag, "src") + code + closeTag;
    },
  );

  // 4) media & SVG resource attrs → data: URIs
  html = html.replace(
    /<(img|source|video|audio|track|image|use)\b[^>]*>/gi,
    (tag) => {
      const a = parseAttrs(tag);
      // srcset (img/source): rewrite each candidate url
      if ("srcset" in a) {
        const rewriteSrcset = (list) => {
          const out = [];
          for (const cand of list.split(",")) {
            const parts = cand.split(/\s+/).filter((x) => x.length);
            if (!parts.length) continue;
            const uri = dataUri(baseDir, parts[0]);
            parts[0] = uri ? uri : parts[0];
            out.push(parts.join(" "));
          }
          return 'srcset="' + out.join(", ") + '"';
        };
        tag = tag.replace(/srcset\s*=\s*"([^"]*)"/i, (mm, g1) =>
          rewriteSrcset(g1),
        );
        tag = tag.replace(/srcset\s*=\s*'([^']*)'/i, (mm, g1) =>
          rewriteSrcset(g1),
        );
      }
      for (const attr of ["src", "href", "xlink:href", "poster", "data"]) {
        if (attr in a) {
          const uri = dataUri(baseDir, a[attr]);
          if (uri !== null) tag = setAttr(tag, attr, uri);
        }
      }
      return tag;
    },
  );

  // 5) inline style="…url()…" attributes on any element
  html = html.replace(
    /style\s*=\s*"([^"]*url\([^"]*)"/gi,
    (full, g1) =>
      'style="' + inlineCss(g1, baseDir, 0).replace(/"/g, "&quot;") + '"',
  );

  return html;
}

export function scrubSecrets(html) {
  const pattern = process.env.SECRET_PATTERN || "";
  if (!pattern) return html;
  let n = 0;
  const re = new RegExp(pattern, "g");
  const scrubbed = html.replace(re, () => {
    n += 1;
    return "«redacted»";
  });
  if (n) {
    _warn("secret-scrubbed", "", `${n} secret-like value(s) redacted from the bundle`);
  }
  return scrubbed;
}

function main(argv) {
  if (argv.length < 1) {
    process.stderr.write("usage: glimpse-export.mjs <src.html>\n");
    return 2;
  }
  const src = argv[0];
  let html;
  try {
    html = decodeUtf8(fs.readFileSync(src));
  } catch (exc) {
    process.stderr.write(
      `glimpse export: cannot read ${src}: ${exc && exc.message ? exc.message : exc}\n`,
    );
    return 1;
  }
  const baseDir = path.dirname(path.resolve(src));
  const out = scrubSecrets(transform(html, baseDir));
  process.stdout.write(out);
  for (const [kind, ref, reason] of _WARNINGS) {
    const loc = ref ? ` ${ref}` : "";
    const tail = reason ? ` — ${reason}` : "";
    process.stderr.write(`glimpse export: [${kind}]${loc}${tail}\n`);
  }
  return 0;
}

import { fileURLToPath } from "node:url";
const isMain = (() => {
  try {
    return (
      process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
})();

if (isMain) process.exit(main(process.argv.slice(2)));
