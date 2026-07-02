/*
 * glimpse-annotate.js — highlight-to-chat, the in-artifact half.
 * =============================================================================
 * This module is injected (at render time, by the canvas shell — never written
 * to artifact files) into the *sandboxed* artifact iframe. The iframe runs at an
 * opaque origin ("null"), so the shell cannot read into it; this code is the only
 * thing that can see the artifact's DOM and the user's text selection.
 *
 * What it does: lets the user drag-select a passage, ask a question about it, and
 * see the agent's answer threaded next to the highlight. It talks to the shell
 * ONLY via postMessage (validated by a per-iframe channelId) and renders all of
 * its own chrome inside a Shadow DOM so artifact CSS and helper CSS can never
 * collide.
 *
 * SECURITY INVARIANTS (do not weaken):
 *   - All user/agent text is rendered with textContent / createTextNode — NEVER
 *     innerHTML / insertAdjacentHTML / inline event handlers.
 *   - Inbound messages must come from window.parent, from the canvas origin, and
 *     carry the matching channelId. Anything else is dropped.
 * =============================================================================
 */
(function () {
  "use strict";

  /* =========================================================================
   * Pure, DOM-only helpers (also exported at the bottom for Node unit tests).
   * Defined BEFORE the config bail so `require()` in tests gets them even though
   * the browser-only chrome below never runs without a __GLIMPSE__ config.
   * ======================================================================= */

  // Inline markdown → DOM nodes. Mirrors glimpse-explain.js's appendInline so the
  // rail renders agent replies the same way the code-explainer does. Builds nodes
  // with createElement/textContent/createTextNode ONLY — never innerHTML — which
  // keeps the module's security invariant intact (untrusted text is never parsed
  // as HTML).
  function appendInline(parent, text) {
    var re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
    var i = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > i) parent.appendChild(document.createTextNode(text.slice(i, m.index)));
      if (m[1]) { var b = document.createElement("strong"); b.textContent = m[2]; parent.appendChild(b); }
      else if (m[3]) { var em = document.createElement("em"); em.textContent = m[4]; parent.appendChild(em); }
      else if (m[5]) { var c = document.createElement("code"); c.textContent = m[6]; parent.appendChild(c); }
      else if (m[7]) {
        var label = m[8], url = m[9];
        if (/^(https?:|mailto:)/i.test(url)) {
          var a = document.createElement("a"); a.setAttribute("href", url);
          a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener noreferrer");
          a.textContent = label; parent.appendChild(a);
        } else {
          parent.appendChild(document.createTextNode(m[7]));   // inert: keep literal "[x](url)"
        }
      }
      i = re.lastIndex;
    }
    if (i < text.length) parent.appendChild(document.createTextNode(text.slice(i)));
  }

  // Block markdown (fenced code / headings / unordered lists / paragraphs) → a
  // DocumentFragment. Mirrors glimpse-explain.js's safeMarkdown.
  function safeMarkdown(md) {
    var frag = document.createDocumentFragment();
    var lines = String(md == null ? "" : md).split("\n");
    var list = null;
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      // Fenced code block: ```lang … ``` — collect verbatim to the closing fence (or
      // end of text, if the reply left it unterminated) and render as a real <pre>,
      // never line-by-line paragraphs with inline marks mangling the code.
      var fence = /^```(\w*)\s*$/.exec(line);
      if (fence) {
        list = null;
        var buf = [];
        li++;
        while (li < lines.length && !/^```\s*$/.test(lines[li])) { buf.push(lines[li]); li++; }
        frag.appendChild(buildCodeBlock(buf.join("\n"), fence[1] || ""));
        continue; // li sits on the closing fence (or past end); for-loop advances it
      }
      var h = /^(#{1,3})\s+(.*)$/.exec(line);
      var item = /^[-*]\s+(.*)$/.exec(line);
      if (item) {
        if (!list) { list = document.createElement("ul"); frag.appendChild(list); }
        var liEl = document.createElement("li"); appendInline(liEl, item[1]); list.appendChild(liEl);
        continue;
      }
      list = null;
      if (h) {
        var tag = h[1].length === 1 ? "h2" : h[1].length === 2 ? "h3" : "h4";
        var hEl = document.createElement(tag); appendInline(hEl, h[2]); frag.appendChild(hEl);
      } else if (line.trim() === "") {
        // blank line → implicit paragraph break
      } else {
        var p = document.createElement("p"); appendInline(p, line); frag.appendChild(p);
      }
    }
    return frag;
  }

  // Lightweight tokenizer + code-block builder, mirrored from glimpse-explain.js so the
  // rail highlights fenced code the same way the code-explainer does. Pure DOM
  // (createElement / textContent only — never innerHTML, never addEventListener here);
  // the copy/expand buttons carry only data-hooks, wired via delegation in the browser.
  var _KW = /\b(function|def|return|if|else|elif|for|while|local|const|let|var|class|import|from|raise|try|except|echo|true|false|null|None|True|False)\b/;
  function highlightTokens(code, lang) {
    var s = String(code == null ? "" : code);
    var toks = [];
    var re = /(#[^\n]*|\/\/[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|([A-Za-z_]\w*)/g;
    var i = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > i) toks.push({ text: s.slice(i, m.index), cls: "" });
      if (m[1]) toks.push({ text: m[1], cls: "com" });
      else if (m[2]) toks.push({ text: m[2], cls: "str" });
      else { toks.push({ text: m[3], cls: _KW.test(m[3]) ? "kw" : "" }); }
      i = re.lastIndex;
    }
    if (i < s.length) toks.push({ text: s.slice(i), cls: "" });
    return toks;
  }

  function buildCodeBlock(code, lang) {
    var fig = document.createElement("figure"); fig.className = "gx-code";
    var bar = document.createElement("div"); bar.className = "gx-code-bar";
    var tag = document.createElement("span"); tag.className = "gx-code-lang";
    tag.textContent = lang || "code"; bar.appendChild(tag);
    var btns = document.createElement("span"); btns.className = "gx-code-btns";
    var expand = document.createElement("button");
    expand.className = "gx-code-btn"; expand.setAttribute("type", "button");
    expand.setAttribute("data-gx-expand", "1"); expand.setAttribute("aria-label", "Expand code");
    expand.textContent = "Expand";
    var copy = document.createElement("button");
    copy.className = "gx-code-btn"; copy.setAttribute("type", "button");
    copy.setAttribute("data-gx-copy", "1"); copy.setAttribute("aria-label", "Copy code");
    copy.textContent = "Copy";
    btns.appendChild(expand); btns.appendChild(copy); bar.appendChild(btns);
    fig.appendChild(bar);
    var pre = document.createElement("pre"); pre.className = "gx-code-pre";
    var codeEl = document.createElement("code");
    highlightTokens(code, lang).forEach(function (t) {
      var span = document.createElement("span");
      if (t.cls) span.className = "tok-" + t.cls;
      span.textContent = t.text; codeEl.appendChild(span);
    });
    pre.appendChild(codeEl); fig.appendChild(pre);
    return fig;
  }

  // Should this textarea keydown send the message? Enter sends; Shift+Enter inserts
  // a newline; Cmd/Ctrl+Enter always sends. Critically for CJK users: a keydown that
  // is confirming an IME composition (e.g. selecting a Chinese candidate with Enter)
  // reports isComposing/keyCode 229 and must NEVER send.
  function shouldSend(e) {
    if (!e || e.key !== "Enter") return false;
    if (e.isComposing || e.keyCode === 229) return false;
    if (e.metaKey || e.ctrlKey) return true;
    return !e.shiftKey;
  }

  // Grow a textarea to fit its content (capped at `max`px; it scrolls past that),
  // unless the user has manually dragged the resize handle — then leave their size
  // alone. Drag is detected as a rendered-height change we didn't make.
  function autoGrow(ta, max) {
    if (!ta || ta._manual) return;
    max = max || 220;
    if (ta._autoH != null && Math.abs(ta.offsetHeight - ta._autoH) > 2) { ta._manual = true; return; }
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, max) + "px";
    ta._autoH = ta.offsetHeight;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { safeMarkdown: safeMarkdown, appendInline: appendInline, shouldSend: shouldSend, highlightTokens: highlightTokens };
  }

  var CFG = window.__GLIMPSE__;
  // Bail unless the shell injected a config and annotation is enabled. Running
  // twice (e.g. double-injection) is a no-op.
  if (!CFG || !CFG.channelId || CFG.annotate === false || window.__glimpse_annotate_loaded) return;
  window.__glimpse_annotate_loaded = true;

  var CHANNEL = CFG.channelId;
  var PARENT_ORIGIN = CFG.origin || "";   // the canvas origin, e.g. http://127.0.0.1:4321
  var SLUG = CFG.slug || "";
  var MIN_SELECTION = 10;                 // Latin-char floor below which the toolbar stays hidden (anti-noise)
  // CJK / Japanese / Korean pack meaning into far fewer characters than Latin script,
  // so a 2-char selection ("幂等", "缓存") is a legitimate passage. Count ideographs as
  // worth ~5 Latin chars so the anti-noise floor adapts to the script being read.
  function meetsMin(txt) {
    var t = (txt || "").trim(); if (!t) return false;
    var cjk = (t.match(/[㐀-鿿぀-ヿ가-힯豈-﫿]/g) || []).length;
    return (t.length - cjk) + cjk * 5 >= MIN_SELECTION;
  }
  var CONTEXT = 32;                       // prefix/suffix length for the text-quote anchor
  var GUTTER_W = 300;                     // px reserved for the comment rail
  var COLLAPSE_AFTER = 4;                 // turns shown before a thread collapses

  /* ---- liveness (set by the shell from the bridge heartbeat) ---------------- */
  var bridgeLive = true;

  /* ---- local question state, keyed by clientTurnId -------------------------- *
   * Optimistic entries are created on submit for instant feedback; the thread
   * push from the shell (read from threads/<slug>.json) is authoritative and is
   * reconciled in by clientTurnId. */
  // A "comment" is a conversation anchored to one passage. It grows: user turn,
  // agent turn, follow-up user turn, … Grouped by the anchor so a follow-up lands
  // in the SAME comment (one mark, one bubble).
  var comments = [];    // [{gid, key, anchor, quote, num, color, unanchored, state, turns:[], draft, _expanded}]
  var byKey = {};       // anchorKey -> comment
  var gidSeq = 0;       // safe DOM id source (anchor text is unsafe as an id)
  function anchorKey(a) {
    if (a && a.kind === "node" && a.id) return "node:" + a.id;
    return (a && a.exact) ? ("a:" + a.exact + "#" + (a.occurrence || 0)) : null;
  }
  function getByGid(gid) { for (var i = 0; i < comments.length; i++) if (comments[i].gid === gid) return comments[i]; return null; }
  function newComment(anchor, quote) {
    var c = { gid: "c" + (++gidSeq), key: anchorKey(anchor), anchor: anchor || null, quote: quote || "",
              num: comments.length + 1, color: hueFor(comments.length), unanchored: !anchor,
              state: "composing", turns: [], draft: "", _expanded: false, _collapsed: false };
    comments.push(c); if (c.key) byKey[c.key] = c;
    return c;
  }
  // A textarea bound to the comment's draft. It auto-grows to fit what's typed
  // (so long drafts are readable) while still allowing a manual drag-resize.
  function mkInput(c, placeholder) {
    var ta = document.createElement("textarea");
    ta.setAttribute("aria-label", "Your message about the selected passage");
    ta.placeholder = placeholder;
    ta.value = c.draft || "";
    ta.addEventListener("input", function () { c.draft = ta.value; autoGrow(ta); });
    // Fit to any restored draft once the textarea is laid out in the shadow tree.
    requestAnimationFrame(function () { autoGrow(ta); });
    return ta;
  }
  // Wire a textarea + Send button: disable Send when empty, send on Enter
  // (Shift+Enter / IME-composition Enter still insert a newline), and guard against
  // double-send (rapid clicks).
  function wireSend(c, ta, btn) {
    var refresh = function () { btn.disabled = !ta.value.trim(); };
    var fire = function () {
      if (btn.disabled) return;
      var v = ta.value;
      // Clear the live field NOW: on macOS a button click leaves focus on the
      // textarea, so renderAll's focus-save would otherwise copy the sent text
      // back into c.draft and the next textarea would render pre-filled.
      ta.value = ""; c.draft = "";
      btn.disabled = true;
      sendTurn(c, v);
    };
    ta.addEventListener("input", refresh);
    ta.addEventListener("keydown", function (e) { if (shouldSend(e)) { e.preventDefault(); fire(); } });
    btn.addEventListener("click", fire);
    refresh();
  }

  /* =========================================================================
   * 1. Text-quote anchoring
   * Capture and re-find use the SAME text source (concatenated text-node
   * content, no normalization) so they can never disagree. An anchor is
   * {exact, prefix, suffix, occurrence}; resolution degrades visibly (a 0-match
   * anchor becomes an "unanchored" bubble, never a silent drop).
   * ======================================================================= */
  function buildSegments() {
    // Walk visible text nodes in document order, recording each node's slice of
    // the concatenated FULL string. Skips our own shadow host + <script>/<style>.
    var segs = [], full = "";
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentNode;
        if (!p) return NodeFilter.FILTER_REJECT;
        var tag = p.nodeName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
        // Skip our own chrome AND our number badges, so they never pollute the
        // concatenated text an anchor is captured/resolved against.
        if (p.closest && (p.closest("#__glimpse_layer") || p.closest("sup.glimpse-badge"))) return NodeFilter.FILTER_REJECT;
        return n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var n;
    while ((n = walker.nextNode())) {
      segs.push({ node: n, gStart: full.length, text: n.nodeValue });
      full += n.nodeValue;
    }
    return { segs: segs, full: full };
  }

  function globalOffset(segs, container, offset) {
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].node === container) return segs[i].gStart + offset;
    }
    return -1;
  }

  function captureAnchor(range) {
    var model = buildSegments();
    var gs = globalOffset(model.segs, range.startContainer, range.startOffset);
    var ge = globalOffset(model.segs, range.endContainer, range.endOffset);
    if (gs < 0 || ge < 0 || ge <= gs) return null;
    var exact = model.full.slice(gs, ge);
    // which occurrence of `exact` is this (0-based)?
    var occ = 0, idx = model.full.indexOf(exact);
    while (idx >= 0 && idx < gs) { occ++; idx = model.full.indexOf(exact, idx + 1); }
    return {
      exact: exact,
      prefix: model.full.slice(Math.max(0, gs - CONTEXT), gs),
      suffix: model.full.slice(ge, ge + CONTEXT),
      occurrence: occ
    };
  }

  // Resolve an anchor against the CURRENT document → [gStart,gEnd] or null.
  function resolveAnchor(anchor, model) {
    if (!anchor || !anchor.exact) return null;
    var hits = [];
    var i = model.full.indexOf(anchor.exact);
    while (i >= 0) { hits.push(i); i = model.full.indexOf(anchor.exact, i + 1); }
    if (!hits.length) return null;
    if (hits.length === 1) return [hits[0], hits[0] + anchor.exact.length];
    // Multiple matches: score by surrounding context, fall back to occurrence index.
    var best = -1, bestScore = -1;
    for (var h = 0; h < hits.length; h++) {
      var p = model.full.slice(Math.max(0, hits[h] - CONTEXT), hits[h]);
      var s = model.full.slice(hits[h] + anchor.exact.length, hits[h] + anchor.exact.length + CONTEXT);
      var score = commonTail(p, anchor.prefix || "") + commonHead(s, anchor.suffix || "");
      if (score > bestScore) { bestScore = score; best = hits[h]; }
    }
    if (bestScore > 0) return [best, best + anchor.exact.length];
    var k = Math.min(anchor.occurrence || 0, hits.length - 1);
    return [hits[k], hits[k] + anchor.exact.length];
  }
  function commonTail(a, b) { var n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; }
  function commonHead(a, b) { var n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; }

  // Wrap [gStart,gEnd) in <mark> elements (one per overlapped text node) sharing
  // a data-gid. Returns the first mark (the badge/scroll anchor) or null.
  function markRange(model, gStart, gEnd, gid, color) {
    var first = null;
    for (var i = 0; i < model.segs.length; i++) {
      var seg = model.segs[i], segEnd = seg.gStart + seg.text.length;
      if (segEnd <= gStart || seg.gStart >= gEnd) continue;
      var a = Math.max(gStart, seg.gStart) - seg.gStart;
      var b = Math.min(gEnd, segEnd) - seg.gStart;
      if (b <= a || !seg.node.parentNode) continue;
      var r = document.createRange();
      try { r.setStart(seg.node, a); r.setEnd(seg.node, b); } catch (e) { continue; }
      var m = document.createElement("mark");
      m.className = "glimpse-mark";
      m.setAttribute("data-glimpse-gid", gid);
      m.style.background = color;
      m.style.color = "inherit";
      m.style.padding = "0 .05em";
      m.style.borderRadius = "2px";
      m.style.cursor = "pointer";
      try { r.surroundContents(m); } catch (e) { continue; }   // splits the text node
      if (!first) first = m;
    }
    return first;
  }

  function unwrapMarks() {
    // Remove badges first so they don't leak out of the <mark> when we unwrap.
    var badges = document.querySelectorAll("sup.glimpse-badge");
    for (var b = 0; b < badges.length; b++) if (badges[b].parentNode) badges[b].parentNode.removeChild(badges[b]);
    var marks = document.querySelectorAll("mark.glimpse-mark");
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i], p = m.parentNode; if (!p) continue;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m); p.normalize();
    }
  }

  /* =========================================================================
   * 2. Shadow-DOM UI layer (toolbar, comment rail, bubbles, hint)
   * ======================================================================= */
  var host = document.createElement("div");
  host.id = "__glimpse_layer";
  var shadow = host.attachShadow({ mode: "open" });
  var bg = getBg();
  var dark = luminance(bg) < 0.35;
  var PALETTE = dark
    ? ["#7aa2f7", "#9ece6a", "#e0af68", "#bb9af7", "#7dcfff", "#f7768e"]
    : ["#3b5bdb", "#2f9e44", "#e8590c", "#7048e8", "#1098ad", "#e03131"];
  function hueFor(i) { return PALETTE[i % PALETTE.length]; }
  function tint(hex) { return hexToRgba(hex, dark ? 0.28 : 0.22); }   // <mark> background

  // All shadow chrome is built via DOM APIs below — never innerHTML with data.
  var style = document.createElement("style");
  style.textContent = [
    ":host{ all:initial; }",
    ".rail{ position:fixed; top:0; right:0; width:" + GUTTER_W + "px; height:100%; pointer-events:none;",
    "  font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; z-index:2147483646; }",
    ".bubble{ position:absolute; right:12px; width:" + (GUTTER_W - 24) + "px; pointer-events:auto;",
    "  display:flex; flex-direction:column; overflow:hidden;",   // header + scrollable turns + pinned footer; max-height set inline by reposition
    "  background:" + (dark ? "#1c2030" : "#ffffff") + "; color:" + (dark ? "#e6e8ee" : "#1a1d24") + ";",
    "  border:1px solid " + (dark ? "#2a3040" : "#e3e6ee") + "; border-radius:8px;",
    "  box-shadow:0 4px 16px rgba(0,0,0," + (dark ? ".45" : ".12") + "); }",
    ".bubble .hd{ display:flex; align-items:center; gap:8px; padding:8px 10px; flex:0 0 auto; cursor:pointer; border-bottom:1px solid " + (dark ? "#2a3040" : "#eef0f6") + "; }",
    ".bubble.collapsed .hd{ border-bottom:0; }",
    ".bubble .count{ flex:0 0 auto; font-size:10.5px; opacity:.55; }",
    ".bubble .tog{ flex:0 0 auto; background:none; border:0; color:inherit; opacity:.55; cursor:pointer; font-size:12px; line-height:1; padding:2px 3px; }",
    ".bubble .tog:hover{ opacity:1; }",
    ".scroll{ overflow-y:auto; min-height:0; padding:8px 10px; display:flex; flex-direction:column; gap:8px; }",   // turns scroll so the footer stays pinned
    ".foot{ flex:0 0 auto; padding:8px 10px; border-top:1px solid " + (dark ? "#2a3040" : "#eef0f6") + "; }",
    ".bubble.collapsed .scroll, .bubble.collapsed .foot{ display:none; }",
    ".badge{ flex:0 0 auto; width:18px; height:18px; border-radius:5px; color:#fff; font-weight:700;",
    "  font-size:11px; display:flex; align-items:center; justify-content:center; }",
    ".quote{ flex:1; min-width:0; font-size:11.5px; opacity:.75; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }",
    // No inner scroll container — an overflow:auto bubble would swallow wheel events
    // over the gutter and block page scroll. Long threads stay short via collapse.
    ".body{ padding:8px 10px; display:flex; flex-direction:column; gap:8px; }",
    ".turn{ font-size:13px; }",
    ".turn.u{ opacity:.95; }",
    ".turn.a{ background:" + hexToRgba(dark ? "#7aa2f7" : "#3b5bdb", dark ? 0.1 : 0.07) + "; padding:7px 9px; border-radius:6px;",
    "  border-left:2px solid " + hexToRgba(dark ? "#7aa2f7" : "#3b5bdb", 0.55) + "; }",   // mark agent replies vs the user's bold question
    // agent replies are rendered markdown (safeMarkdown) — keep the block elements tight
    ".turn.a p{ margin:.35em 0; } .turn.a p:first-child{ margin-top:0; } .turn.a p:last-child{ margin-bottom:0; }",
    ".turn.a ul{ margin:.35em 0; padding-left:1.25em; } .turn.a li{ margin:.12em 0; }",
    ".turn.a h2,.turn.a h3,.turn.a h4{ margin:.5em 0 .25em; font-size:1.02em; line-height:1.3; }",
    ".turn.a code{ font:12px ui-monospace,Menlo,monospace; background:" + (dark ? "#0e1118" : "#eef0f6") + "; padding:.05em .3em; border-radius:3px; }",
    ".turn.a a{ color:" + (dark ? "#7aa2f7" : "#3b5bdb") + "; }",
    // fenced code block in agent replies — a real, scrollable, copyable, expandable
    // <pre> instead of literal ``` lines. Fixed dark code theme in both page themes.
    ".gx-code{ margin:.45em 0; border:1px solid rgba(127,127,127,.25); border-radius:8px; overflow:hidden; background:#0f1117; }",
    ".gx-code-bar{ display:flex; align-items:center; justify-content:space-between; gap:8px; padding:3px 5px 3px 9px; background:#0f1117; border-bottom:1px solid rgba(255,255,255,.08); }",
    ".gx-code-lang{ font:11px ui-monospace,Menlo,monospace; color:#e6e7ea; opacity:.55; text-transform:lowercase; }",
    ".gx-code-btns{ display:flex; gap:4px; }",
    ".gx-code-btn{ font:11px/1 -apple-system,BlinkMacSystemFont,sans-serif; font-weight:600; color:#e6e7ea; background:rgba(255,255,255,.09); border:0; border-radius:5px; padding:4px 8px; cursor:pointer; opacity:.85; }",
    ".gx-code-btn:hover{ opacity:1; background:rgba(255,255,255,.16); }",
    ".gx-code-btn:focus-visible{ outline:2px solid #7aa2f7; outline-offset:1px; }",
    ".gx-code-pre{ margin:0; background:#0f1117; color:#e6e7ea; padding:9px 10px; overflow:auto; resize:vertical; max-height:300px; min-height:38px; font:12px/1.5 ui-monospace,Menlo,monospace; }",
    // reset the inline `.turn.a code` pill so block code is flat (higher specificity wins)
    ".turn.a .gx-code-pre code{ background:none; padding:0; border-radius:0; white-space:pre; font:inherit; }",
    ".gx-code-pre .tok-kw,.gx-code-modal .tok-kw{ color:#9bb7ff; } .gx-code-pre .tok-str,.gx-code-modal .tok-str{ color:#b5e8a0; } .gx-code-pre .tok-com,.gx-code-modal .tok-com{ color:#8b93a7; }",
    // expand overlay: fixed dialog filling the viewport, for reading long code out of the narrow rail
    ".gx-code-overlay{ display:none; position:fixed; inset:0; z-index:2147483647; background:rgba(8,10,16,.62); padding:22px; box-sizing:border-box; pointer-events:auto; }",
    ".gx-code-overlay.on{ display:flex; align-items:center; justify-content:center; }",
    ".gx-code-modal{ display:flex; flex-direction:column; width:min(920px,100%); max-height:100%; background:#0f1117; border:1px solid rgba(255,255,255,.14); border-radius:10px; overflow:hidden; box-shadow:0 12px 40px rgba(0,0,0,.5); }",
    ".gx-code-modal pre{ margin:0; flex:1; background:#0f1117; color:#e6e7ea; padding:13px 15px; overflow:auto; max-height:82vh; font:13px/1.55 ui-monospace,Menlo,monospace; }",
    ".gx-code-modal code{ background:none; padding:0; border-radius:0; white-space:pre; }",
    ".q{ font-weight:650; }",
    "button[disabled]{ opacity:.45; cursor:default; }",
    ".meta{ font-size:11px; opacity:.6; margin-top:2px; }",
    ".dots span{ display:inline-block; width:5px; height:5px; border-radius:50%; margin-right:3px;",
    "  background:" + (dark ? "#aeb6c6" : "#8a93a6") + "; animation:gl-p 1.2s infinite ease-in-out; }",
    ".dots span:nth-child(2){ animation-delay:.2s; } .dots span:nth-child(3){ animation-delay:.4s; }",
    ".dots.ack span{ animation-duration:2.2s; opacity:.5; }",   // acknowledged: slower, dimmer than in-flight",
    "@keyframes gl-p{ 0%,80%,100%{ opacity:.3 } 40%{ opacity:1 } }",
    ".tag{ font-size:10.5px; font-weight:700; padding:1px 6px; border-radius:5px; text-transform:uppercase; letter-spacing:.3px; }",
    ".tag.off{ background:" + (dark ? "#3a2e15" : "#fff3bf") + "; color:" + (dark ? "#e0af68" : "#a8730a") + "; }",
    ".tag.warn{ background:" + (dark ? "#3a1f1f" : "#ffe3e3") + "; color:" + (dark ? "#f7768e" : "#c92a2a") + "; }",
    "textarea{ width:100%; box-sizing:border-box; resize:vertical; min-height:46px; max-height:220px; overflow-y:auto; font:inherit;",
    "  border:1px solid " + (dark ? "#2a3040" : "#d0d5e2") + "; border-radius:6px; padding:6px 8px;",
    "  background:" + (dark ? "#11141d" : "#fbfcff") + "; color:inherit; outline:none; }",
    "textarea:focus{ border-color:" + (dark ? "#7aa2f7" : "#3b5bdb") + "; }",
    ".row{ display:flex; gap:6px; justify-content:flex-end; margin-top:6px; }",
    "button{ font:inherit; font-size:12.5px; border-radius:6px; padding:5px 12px; cursor:pointer; border:1px solid transparent; }",
    ".primary{ background:" + (dark ? "#7aa2f7" : "#3b5bdb") + "; color:#fff; }",
    ".ghost{ background:transparent; color:inherit; border-color:" + (dark ? "#2a3040" : "#d0d5e2") + "; }",
    ".more{ background:none; border:0; color:" + (dark ? "#7aa2f7" : "#3b5bdb") + "; padding:4px; font-size:12px; cursor:pointer; width:100%; text-align:center; }",
    ".toolbar{ position:fixed; pointer-events:auto; z-index:2147483647; display:none;",
    "  background:" + (dark ? "#1c2030" : "#1a1d24") + "; border-radius:7px; box-shadow:0 4px 14px rgba(0,0,0,.4); }",
    ".toolbar button{ background:transparent; color:#fff; border:0; padding:6px 12px; font-weight:600; }",
    ".toolbar button:hover{ color:#7aa2f7; }",
    ".toolbar button:focus-visible{ outline:2px solid #7aa2f7; outline-offset:-2px; }",
    ".toolbar .sep{ display:inline-block; width:1px; height:14px; background:rgba(255,255,255,.22); vertical-align:middle; }",
    ".hint{ position:fixed; right:16px; bottom:16px; pointer-events:none; z-index:2147483646;",
    "  background:" + (dark ? "rgba(28,32,48,.95)" : "rgba(26,29,36,.92)") + "; color:#fff; font-size:12px;",
    "  padding:7px 12px; border-radius:7px; transition:opacity .4s; }",
    ".inline{ display:block; margin:8px 0; pointer-events:auto; }",
    // spotlight: dims everything except the anchored passage when a comment is clicked
    ".spot{ position:fixed; border-radius:4px; box-shadow:0 0 0 9999px rgba(0,0,0,.5); pointer-events:none; z-index:2147483645; transition:opacity .25s; }"
  ].join("\n");
  shadow.appendChild(style);

  var rail = el("div", "rail"); shadow.appendChild(rail);
  var toolbar = el("div", "toolbar"); toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Annotation actions");
  var askBtn = el("button"); askBtn.textContent = "Ask"; askBtn.type = "button";
  askBtn.title = "Ask your own question about the selection";
  var sep = el("span", "sep"); sep.setAttribute("aria-hidden", "true");
  var explainBtn = el("button"); explainBtn.textContent = "Explain"; explainBtn.type = "button";
  explainBtn.title = "Get a short, example-based explanation";
  toolbar.appendChild(askBtn); toolbar.appendChild(sep); toolbar.appendChild(explainBtn);
  shadow.appendChild(toolbar);

  (document.body || document.documentElement).appendChild(host);
  wireCodeBlocks(shadow);

  // Wire copy/expand on every fenced code block via one delegated listener on the
  // shadow root (buildCodeBlock leaves only data-hooks, so this is the sole place
  // browser events touch those buttons — keeps the Node DOM-shim tests pure). One
  // reusable overlay, appended to the shadow so it inherits the rail's styles.
  function wireCodeBlocks(root) {
    if (!root || !root.addEventListener) return;
    var overlay = el("div", "gx-code-overlay");
    overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Expanded code");
    var modal = el("div", "gx-code-modal");
    var bar = el("div", "gx-code-bar");
    var oLang = el("span", "gx-code-lang");
    var oBtns = el("span", "gx-code-btns");
    var oCopy = el("button", "gx-code-btn"); oCopy.setAttribute("type", "button");
    oCopy.setAttribute("data-gx-copy", "1"); oCopy.setAttribute("aria-label", "Copy code"); oCopy.textContent = "Copy";
    var oClose = el("button", "gx-code-btn"); oClose.setAttribute("type", "button");
    oClose.setAttribute("data-gx-close", "1"); oClose.setAttribute("aria-label", "Close"); oClose.textContent = "Close";
    oBtns.appendChild(oCopy); oBtns.appendChild(oClose);
    bar.appendChild(oLang); bar.appendChild(oBtns);
    var oPre = document.createElement("pre"); var oCode = document.createElement("code"); oPre.appendChild(oCode);
    modal.appendChild(bar); modal.appendChild(oPre); overlay.appendChild(modal);
    root.appendChild(overlay);

    var lastFocus = null;
    function flash(btn) {
      var txt = btn.textContent, lab = btn.getAttribute("aria-label");
      btn.textContent = "Copied"; btn.setAttribute("aria-label", "Copied");
      setTimeout(function () { btn.textContent = txt; btn.setAttribute("aria-label", lab); }, 1200);
    }
    function copyText(text, btn) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { flash(btn); }, function () {});
          return;
        }
      } catch (e) { /* fall through */ }
      try {
        var ta = document.createElement("textarea"); ta.value = text;
        ta.style.position = "fixed"; ta.style.opacity = "0";
        (document.body || document.documentElement).appendChild(ta); ta.focus(); ta.select();
        document.execCommand("copy"); ta.remove(); flash(btn);
      } catch (e) { /* clipboard unavailable — quietly no-op */ }
    }
    function openOverlay(fig, trigger) {
      var srcCode = fig.querySelector(".gx-code-pre code");
      var srcLang = fig.querySelector(".gx-code-lang");
      oLang.textContent = srcLang ? srcLang.textContent : "code";
      oCode.textContent = "";
      if (srcCode) { var k = srcCode.childNodes; for (var i = 0; i < k.length; i++) oCode.appendChild(k[i].cloneNode(true)); }
      lastFocus = trigger || null;
      overlay.classList.add("on"); oClose.focus();
    }
    function closeOverlay() {
      if (!overlay.classList.contains("on")) return;
      overlay.classList.remove("on");
      if (lastFocus && lastFocus.focus) lastFocus.focus();
      lastFocus = null;
    }
    root.addEventListener("click", function (e) {
      var t = e.target; if (!t || !t.closest) return;
      var copyBtn = t.closest("[data-gx-copy]");
      if (copyBtn && !copyBtn.closest(".gx-code-overlay")) {
        e.stopPropagation();
        var f = copyBtn.closest(".gx-code"); var c = f && f.querySelector(".gx-code-pre code");
        if (c) copyText(c.textContent, copyBtn);
        return;
      }
      var expandBtn = t.closest("[data-gx-expand]");
      if (expandBtn) { e.stopPropagation(); var f2 = expandBtn.closest(".gx-code"); if (f2) openOverlay(f2, expandBtn); }
    });
    overlay.addEventListener("click", function (e) {
      var t = e.target; if (!t) return;
      e.stopPropagation();
      if (t === overlay || (t.closest && t.closest("[data-gx-close]"))) { closeOverlay(); return; }
      var cb = t.closest && t.closest("[data-gx-copy]");
      if (cb) copyText(oCode.textContent, cb);
    });
    root.addEventListener("keydown", function (e) { if (e.key === "Escape") closeOverlay(); });
  }

  // First-run hint (once per session; the shell passes firstRun).
  if (CFG.firstRun) {
    var hint = el("div", "hint");
    hint.textContent = "Select any text to ask the agent about it";
    shadow.appendChild(hint);
    setTimeout(function () { hint.style.opacity = "0"; setTimeout(function () { hint.remove(); }, 500); }, 6000);
  }

  /* =========================================================================
   * 3. Selection → toolbar → compose
   * ======================================================================= */
  var pendingRange = null, pointerDown = false;
  document.addEventListener("pointerdown", function () { pointerDown = true; }, true);
  document.addEventListener("pointerup", function () { pointerDown = false; }, true);
  // Keep the selection alive when the user clicks Ask (mousedown would otherwise
  // collapse it before the click handler runs).
  askBtn.addEventListener("mousedown", function (e) { e.preventDefault(); });
  explainBtn.addEventListener("mousedown", function (e) { e.preventDefault(); });

  document.addEventListener("selectionchange", debounce(function () {
    var sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideToolbar(); return; }
    var txt = sel.toString();
    if (!meetsMin(txt)) { hideToolbar(); return; }
    var r = sel.getRangeAt(0);
    if (host.contains(r.commonAncestorContainer)) return;     // ignore selections inside our own UI
    pendingRange = r.cloneRange();
    showToolbar(r.getBoundingClientRect());
    // Keyboard selection (Shift+arrows): move focus to the toolbar so it's reachable
    // without a mouse. Don't steal focus mid mouse-drag.
    if (!pointerDown) try { askBtn.focus(); } catch (e2) {}
  }, 120));
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { hideToolbar(); clearSpot(); }
    if (e.key === "]" || e.key === "[") jumpThread(e.key === "]" ? 1 : -1);
  });

  function showToolbar(rect) {
    toolbar.style.display = "block";
    var top = (rect.top || 0) - 40; if (top < 4) top = (rect.bottom || 0) + 8;
    var left = (rect.right || 0) - 20;
    var maxLeft = window.innerWidth - 90;
    toolbar.style.top = Math.max(4, top) + "px";
    toolbar.style.left = Math.max(4, Math.min(left, maxLeft)) + "px";
  }
  function hideToolbar() { toolbar.style.display = "none"; }

  function captureSelection() {
    if (!pendingRange) return null;
    var anchor = captureAnchor(pendingRange);
    // Prefer the anchor's clean `exact` (badge digits excluded) over the raw
    // selection string for the displayed quote.
    var quote = (anchor && anchor.exact) ? anchor.exact : pendingRange.toString();
    return { anchor: anchor, quote: quote };
  }
  askBtn.addEventListener("click", function () {
    var s = captureSelection(); if (!s) return;
    hideToolbar();
    openComposer(s.anchor, s.quote);          // type your own question
  });
  explainBtn.addEventListener("click", function () {
    var s = captureSelection(); if (!s) return;
    hideToolbar();
    quickAsk(s.anchor, s.quote, "Explain this briefly, using a concrete example.");
  });

  function openComposer(anchor, quote) {
    var k = anchorKey(anchor);
    var c = (k && byKey[k]) ? byKey[k] : newComment(anchor, quote);   // re-asking on a passage reuses its comment
    renderAll();
    var b = bubbleEl(c.gid); var ta = b && b.querySelector("textarea"); if (ta) ta.focus();
  }

  // One-click question with a canned prompt (the Explain button): create/append
  // the turn and send immediately, skipping the composer.
  function quickAsk(anchor, quote, text) {
    var k = anchorKey(anchor);
    var c = (k && byKey[k]) ? byKey[k] : newComment(anchor, quote);
    sendTurn(c, text);
  }

  /* =========================================================================
   * 4. Rendering — marks + bubbles, driven by `comments`
   * ======================================================================= */
  var repositionQueued = false, narrowMode = false;
  function renderAll() {
    // Preserve an in-progress compose across the teardown below — a periodic
    // liveness/thread push must never eat what the user is typing.
    var focusGid = null, caretA = 0, caretB = 0;
    var ae = shadow.activeElement;
    if (ae && ae.tagName === "TEXTAREA" && ae.closest) {
      var ab = ae.closest(".bubble");
      if (ab && ab.id.indexOf("glb-") === 0) {
        focusGid = ab.id.slice(4);
        try { caretA = ae.selectionStart; caretB = ae.selectionEnd; } catch (e) {}
        var fc = getByGid(focusGid); if (fc) fc.draft = ae.value;
      }
    }
    setObserving(false);
    unwrapMarks();
    var model = buildSegments();
    narrowMode = window.innerWidth < (700 + GUTTER_W);   // no room for a side rail → callouts under the line
    rail.textContent = "";
    var firstMarks = {};
    // place one mark per comment
    for (var i = 0; i < comments.length; i++) {
      var c = comments[i];
      c.unanchored = false;
      if (c.anchor) {
        var span = resolveAnchor(c.anchor, model);
        if (span) {
          var first = markRange(model, span[0], span[1], c.gid, tint(c.color));
          if (first) {
            firstMarks[c.gid] = first;
            first.setAttribute("aria-describedby", "glb-" + c.gid);
            first.tabIndex = 0; first.setAttribute("role", "button");
            first.setAttribute("aria-label", "Annotation " + c.num + " — open discussion");
            (function (gid) {
              first.addEventListener("click", function () { focusBubble(gid); });
              first.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); focusBubble(gid); } });
            })(c.gid);
            addBadge(first, c.num, c.color);
          } else c.unanchored = true;
        } else c.unanchored = true;
      } else c.unanchored = true;
    }
    setTimeout(function () { setObserving(true); }, 0);
    for (var j = 0; j < comments.length; j++) {
      renderBubble(comments[j], narrowMode, firstMarks[comments[j].gid]);
    }
    // restore the active textarea's focus + caret
    if (focusGid) {
      var rb = shadow.getElementById("glb-" + focusGid);
      var rta = rb && rb.querySelector("textarea");
      if (rta) { rta.focus(); try { rta.setSelectionRange(caretA, caretB); } catch (e) {} }
    }
    reserveGutter();
    queueReposition();
  }

  // Tell the artifact how much right-edge room the comment rail is occupying, so
  // side-by-side layouts (e.g. the code-explainer panel) can shift clear of it.
  // Reserve only when bubbles are actually shown in the rail and we're not in the
  // stacked narrow mode — otherwise nothing is there to avoid.
  function reserveGutter() {
    var on = !narrowMode && !!rail.querySelector(".bubble");
    try { document.documentElement.style.setProperty("--glimpse-gutter-reserved", (on ? GUTTER_W : 0) + "px"); } catch (e) {}
  }

  function renderBubble(c, narrow, firstMark) {
    var b = el("div", "bubble"); b.id = "glb-" + c.gid;
    b.setAttribute("role", "complementary");
    b.setAttribute("aria-label", "Discussion " + c.num + ": " + (c.quote || "selection").slice(0, 60));
    b.tabIndex = -1;
    if (c._collapsed) b.classList.add("collapsed");
    var hd = el("div", "hd");
    var badge = el("div", "badge"); badge.style.background = c.color; badge.textContent = String(c.num);
    var quote = el("div", "quote"); quote.textContent = c.quote || "(selection)";
    hd.appendChild(badge); hd.appendChild(quote);
    if (c.unanchored) { var w = el("span", "tag warn"); w.textContent = "passage changed"; hd.appendChild(w); }
    var nTurns = (c.turns || []).length;
    if (nTurns) { var cnt = el("span", "count"); cnt.textContent = String(nTurns); hd.appendChild(cnt); }
    // minimize / expand toggle — keeps the rail clean and stops long threads from
    // covering the Send button or other comments.
    var tog = el("button", "tog"); tog.type = "button";
    var syncTog = function () { tog.textContent = c._collapsed ? "▸" : "▾"; tog.title = c._collapsed ? "Expand" : "Minimize"; tog.setAttribute("aria-label", tog.title); };
    syncTog();
    tog.addEventListener("click", function (e) {
      e.stopPropagation();
      c._collapsed = !c._collapsed; b.classList.toggle("collapsed", c._collapsed); syncTog(); queueReposition();
    });
    hd.appendChild(tog);
    hd.addEventListener("click", function (e) { if (e.target !== tog && c._collapsed) tog.click(); });   // header click expands a collapsed bubble
    b.appendChild(hd);

    var scroll = el("div", "scroll");   // the turns (scrolls)
    var foot = el("div", "foot");       // the composer (pinned — Send always visible)
    if (c.state === "composing") {
      var qq = el("div", "turn u"); var qs = el("span", "q"); qs.textContent = "❝" + (c.quote || "selection") + "❞"; qq.appendChild(qs);
      scroll.appendChild(qq);
      var ta = mkInput(c, "Ask about this…  (⏎ send · ⇧⏎ newline)"); foot.appendChild(ta);
      var row = el("div", "row");
      var cancel = el("button", "ghost"); cancel.textContent = "Cancel"; cancel.addEventListener("click", function () { dropComment(c); });
      var ask = el("button", "primary"); ask.textContent = "Ask";
      row.appendChild(cancel); row.appendChild(ask); foot.appendChild(row);
      wireSend(c, ta, ask);
    } else {
      // the growing conversation: user / agent / user / agent …
      var turns = c.turns || [];
      var start = 0;
      if (turns.length > COLLAPSE_AFTER && !c._expanded) start = turns.length - COLLAPSE_AFTER;
      if (start > 0) {
        var more = el("button", "more"); more.textContent = "Show " + start + " earlier";
        more.addEventListener("click", function () { c._expanded = true; renderAll(); });
        scroll.appendChild(more);
      }
      for (var i = start; i < turns.length; i++) {
        var t = turns[i];
        if (t.role === "agent") { var at = el("div", "turn a"); at.appendChild(safeMarkdown(t.text)); scroll.appendChild(at); continue; }
        // user turn
        var ut = el("div", "turn u"); var usp = el("span", "q"); usp.textContent = t.text; ut.appendChild(usp); scroll.appendChild(ut);
        var answered = t.status === "answered" || (turns[i + 1] && turns[i + 1].role === "agent");
        if (!answered) {
          if (t.status === "unsent") {   // always actionable, wherever it sits
            var wm = el("div", "meta"); var wt = el("span", "tag warn"); wt.textContent = "not sent"; wm.appendChild(wt);
            var rt = el("button", "ghost"); rt.textContent = "Retry";
            (function (tt) { rt.addEventListener("click", function () { tt.status = "pending"; renderAll(); resendTurn(c, tt); }); })(t);
            wm.appendChild(rt); scroll.appendChild(wm);
          } else if (i === turns.length - 1) {   // pending/offline only on the latest turn (avoid stacked "agent offline")
            var pend = el("div", "meta");
            if (!bridgeLive) { var off = el("span", "tag off"); off.textContent = "agent offline"; pend.appendChild(off); }
            else { var dots = el("div", "dots" + (t.status === "acknowledged" ? " ack" : "")); dots.appendChild(el("span")); dots.appendChild(el("span")); dots.appendChild(el("span")); pend.appendChild(dots); }
            var ago = el("span"); ago.textContent = t.status === "acknowledged" ? "  sent · waiting" : "  asked"; pend.appendChild(ago);
            scroll.appendChild(pend);
          }
        }
      }
      if (c._expanded && turns.length > COLLAPSE_AFTER) {
        var less = el("button", "more"); less.textContent = "Show less";
        less.addEventListener("click", function () { c._expanded = false; renderAll(); });
        scroll.appendChild(less);
      }
      // follow-up box — keep the conversation going. Enter sends; Shift+Enter newlines.
      var fta = mkInput(c, "Reply…  (⏎ send · ⇧⏎ newline)"); foot.appendChild(fta);
      var frow = el("div", "row");
      var send = el("button", "primary"); send.textContent = "Send";
      frow.appendChild(send); foot.appendChild(frow);
      wireSend(c, fta, send);
    }
    b.appendChild(scroll); b.appendChild(foot);
    b.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest("button, textarea, .more, .hd")) return;
      revealComment(c.gid);
    });
    rail.appendChild(b);
    b._mark = firstMark || null;
  }

  function addBadge(mark, num, color) {
    var badge = document.createElement("sup");
    badge.className = "glimpse-badge";
    badge.setAttribute("data-glimpse-badge", "1");
    badge.textContent = String(num);
    badge.style.cssText = "font-size:.7em;font-weight:700;color:#fff;background:" + color +
      ";border-radius:4px;padding:0 4px;margin-left:2px;vertical-align:top;user-select:none;";
    mark.appendChild(badge);
  }

  // Position bubbles to follow their marks (rAF on scroll/resize). Bubbles stack
  // with a min gap so they never overlap.
  function queueReposition() {
    if (repositionQueued) return; repositionQueued = true;
    requestAnimationFrame(function () {
      repositionQueued = false;
      var bubbles = rail.querySelectorAll(".bubble");
      var vw = window.innerWidth, vh = window.innerHeight;
      var MARGIN = 12, GAP = 10;
      var MAX_H = Math.max(160, vh - MARGIN * 2);   // a bubble never exceeds the viewport
      var lastBottom = MARGIN;
      for (var i = 0; i < bubbles.length; i++) {
        var b = bubbles[i], mark = b._mark, desired;
        var r = mark ? mark.getBoundingClientRect() : null;
        if (narrowMode) {
          // No side room: render each bubble as a callout just under its highlighted line.
          var w = Math.min(GUTTER_W - 24, vw - 24);
          b.style.width = w + "px"; b.style.right = "auto";
          desired = r ? r.bottom + 6 : lastBottom + 4;
          // `left` is relative to the fixed rail (its left edge sits at vw-GUTTER_W),
          // so translate the desired viewport-x back into rail coordinates.
          var vx = r ? Math.max(8, Math.min(r.left, vw - w - 8)) : 8;
          b.style.left = (vx - (vw - GUTTER_W)) + "px";
        } else {
          b.style.right = "12px"; b.style.left = "auto"; b.style.width = "";
          desired = r ? r.top : lastBottom + 4;   // align to the highlight; unanchored flows under the previous
        }
        if (desired < lastBottom) desired = lastBottom;   // stack below the previous bubble — never overlap
        // Measure the bubble's natural height under a viewport cap, then place it so
        // the WHOLE bubble stays on screen. A bubble whose mark sits near the page
        // bottom grows UPWARD instead of being pinned to the bottom with its turns
        // crushed to an unreadable sliver (the old fixed-MIN_VISIBLE bug).
        b.style.maxHeight = MAX_H + "px";
        var h = Math.min(b.offsetHeight, MAX_H);
        var top = Math.min(desired, vh - h - MARGIN);
        if (top < MARGIN) top = MARGIN;
        b.style.top = top + "px";
        // final cap to the room actually below `top` — covers the content-taller-than-
        // viewport case, where the turns scroll inside while the footer stays pinned.
        b.style.maxHeight = Math.max(0, vh - top - MARGIN) + "px";
        lastBottom = top + b.offsetHeight + GAP;
      }
    });
  }
  window.addEventListener("scroll", function () { queueReposition(); if (spotEl && Date.now() - spotAt > 500) clearSpot(); }, true);   // guard skips our own scrollIntoView
  // Clicks inside the shadow UI retarget to the host (#__glimpse_layer) at the
  // document level, so guard on the host id, not ".bubble".
  document.addEventListener("mousedown", function (e) { if (spotEl && !(e.target.closest && e.target.closest("#__glimpse_layer, mark.glimpse-mark"))) clearSpot(); }, true);
  // Resize only changes layout, not anchoring — so debounce and just recompute the
  // narrow/side-rail mode + reposition, instead of a full renderAll() (which re-walks
  // the DOM and rebuilds every mark). Cheaper and avoids thrash while dragging the edge.
  var _resizeT = null;
  window.addEventListener("resize", function () {
    clearTimeout(_resizeT);
    _resizeT = setTimeout(function () {
      narrowMode = window.innerWidth < (700 + GUTTER_W);
      reserveGutter();
      queueReposition();
    }, 120);
  });

  /* =========================================================================
   * 5. Submit + messaging (validated postMessage to/from the shell)
   * ======================================================================= */
  // Append a user turn to a comment and send it up. Works for the first ask AND
  // every follow-up — the conversation just keeps growing.
  function sendTurn(c, value) {
    var text = (value || "").trim(); if (!text) return;
    var cid = uuid();
    var turn = { role: "user", text: text, status: "pending", cid: cid, _optimistic: true, ts: Date.now() / 1000 };
    c.turns.push(turn); c.state = "open"; c.draft = ""; c._collapsed = false;
    renderAll();
    post({ type: "glimpse:annotate", v: 1, channelId: CHANNEL, intent: "ask",
           clientTurnId: cid, anchor: c.anchor, quote: c.quote, text: text });
    armAck(turn);
  }
  function resendTurn(c, turn) {
    post({ type: "glimpse:annotate", v: 1, channelId: CHANNEL, intent: "ask",
           clientTurnId: turn.cid, anchor: c.anchor, quote: c.quote, text: turn.text });
    armAck(turn);
  }
  function armAck(turn) {
    if (turn._ackTimer) clearTimeout(turn._ackTimer);
    turn._ackTimer = setTimeout(function () { if (turn.status === "pending") { turn.status = "unsent"; renderAll(); } }, 3000);
  }
  function dropComment(c) {
    var i = comments.indexOf(c); if (i >= 0) comments.splice(i, 1);
    if (c.key && byKey[c.key] === c) delete byKey[c.key];
    renderAll();
  }
  function post(msg) { try { window.parent.postMessage(msg, "*"); } catch (e) {} }

  window.addEventListener("message", function (e) {
    // Trust gate: must be the shell (parent), the canvas origin, our channel.
    if (e.source !== window.parent) return;
    if (PARENT_ORIGIN && e.origin !== PARENT_ORIGIN) return;
    var d = e.data; if (!d || d.channelId !== CHANNEL) return;
    if (d.type === "glimpse:annotate:ack") {
      for (var ci = 0; ci < comments.length; ci++) {
        var ts = comments[ci].turns;
        for (var ti = 0; ti < ts.length; ti++) {
          if (ts[ti].cid === d.clientTurnId) {
            if (ts[ti]._ackTimer) clearTimeout(ts[ti]._ackTimer);
            if (ts[ti].status === "pending") { ts[ti].status = "acknowledged"; renderAll(); }
            return;
          }
        }
      }
    } else if (d.type === "glimpse:thread") {
      ingestThread(d.turns || []);
    } else if (d.type === "glimpse:liveness") {
      var nowLive = d.state !== "offline";
      if (nowLive !== bridgeLive) { bridgeLive = nowLive; renderAllSoft(); }   // only on change (posted every ~1.5s)
    }
  });

  // The thread file is authoritative. Group its turns by anchor into conversations,
  // preserving in-flight optimistic turns not yet persisted.
  function ingestThread(turns) {
    // Node-anchored turns belong to the code-explainer renderer, not the text rail.
    // When that renderer exposes a hook, peel those turns off (grouped by node id,
    // each group carrying its user turns AND the agent replies that point at them)
    // and hand each group to the hook; the rest flows through the rail logic below
    // unchanged. With no hook present this is a no-op (full back-compat).
    var EX = window.__GLIMPSE_EXPLAIN__;
    if (EX && typeof EX.mountNodeReply === "function") {
      var nodeIdOf = function (a) { return (a && a.kind === "node" && a.id) ? a.id : null; };
      // user turn id -> node id, for routing agent replies to the right group.
      var userNode = {};
      turns.forEach(function (t) {
        if (t.role === "user") { var nid = nodeIdOf(t.anchor); if (nid) userNode[t.id] = nid; }
      });
      var groups = {}, rest = [];
      turns.forEach(function (t) {
        var nid = null;
        if (t.role === "user") nid = nodeIdOf(t.anchor);
        else if (t.role === "agent" && t.replyTo) nid = userNode[t.replyTo] || null;
        if (nid) { (groups[nid] = groups[nid] || []).push(t); }
        else rest.push(t);
      });
      Object.keys(groups).forEach(function (nid) {
        try { EX.mountNodeReply(nid, groups[nid]); } catch (e) {}
      });
      turns = rest;
    }
    var agentByReply = {};
    turns.forEach(function (t) { if (t.role === "agent" && t.replyTo) { (agentByReply[t.replyTo] = agentByReply[t.replyTo] || []).push(t); } });
    var users = turns.filter(function (t) { return t.role === "user"; });
    var keyOf = function (u) { return anchorKey(u.anchor) || ("u:" + u.id); };
    // ensure a comment exists for each anchor group
    users.forEach(function (u) {
      var k = keyOf(u), c = byKey[k];
      if (!c) {
        // maybe this persisted turn is one we sent optimistically (match by cid)
        if (u.clientTurnId) c = comments.filter(function (cc) { return cc.turns.some(function (tt) { return tt.cid === u.clientTurnId; }); })[0];
        // A conversation loaded from the thread file (not one we're actively composing
        // or just sent) starts minimized, so opening a doc shows a clean rail. Only set
        // it on first creation — a comment the user later expands stays expanded.
        if (!c) { c = newComment(u.anchor, u.quote); c._collapsed = true; }
        c.key = k; byKey[k] = c;
      }
      c.anchor = u.anchor || c.anchor; c.quote = u.quote || c.quote; c.unanchored = !c.anchor;
    });
    // rebuild each comment's turn sequence in THREAD-FILE (chronological) order —
    // robust to equal/odd timestamps — plus still-in-flight optimistic turns.
    comments.forEach(function (c) {
      var mine = {};   // user-turn ids belonging to this comment
      users.forEach(function (u) { if (keyOf(u) === c.key) mine[u.id] = 1; });
      if (!Object.keys(mine).length) return;   // purely-optimistic comment not yet persisted
      var seq = [], threadCids = {};
      turns.forEach(function (t) {
        if (t.role === "user" && mine[t.id]) {
          if (t.clientTurnId) threadCids[t.clientTurnId] = 1;
          var answered = (agentByReply[t.id] || []).length > 0;
          seq.push({ role: "user", text: t.text, status: answered ? "answered" : (t.status || "pending"), id: t.id, cid: t.clientTurnId });
        } else if (t.role === "agent" && mine[t.replyTo]) {
          seq.push({ role: "agent", text: t.text, id: t.id });
        }
      });
      (c.turns || []).forEach(function (t) { if (t.role === "user" && t._optimistic && t.cid && !threadCids[t.cid]) seq.push(t); });
      c.turns = seq; c.state = "open";
    });
    renderAll();
  }

  // Light re-render (bubbles only) when marks don't need recomputing.
  function renderAllSoft() { renderAll(); }

  /* =========================================================================
   * 6. Re-anchor on artifact mutation (mermaid late render, tabs, collapsibles)
   * ======================================================================= */
  var observing = false, mo = null, reanchorTimer = null;
  function setObserving(on) {
    if (on === observing) return; observing = on;
    if (on) { if (!mo) mo = new MutationObserver(onMutate); mo.observe(document.body, { childList: true, subtree: true, characterData: true }); }
    else if (mo) mo.disconnect();
  }
  function onMutate(records) {
    // ignore mutations we caused (marks/badges) and our own host
    for (var i = 0; i < records.length; i++) {
      var tgt = records[i].target;
      if (tgt && tgt.nodeType === 1 && (tgt.closest && (tgt.closest("#__glimpse_layer") || tgt.closest("mark.glimpse-mark")))) continue;
      clearTimeout(reanchorTimer);
      reanchorTimer = setTimeout(function () { if (comments.length) renderAll(); else queueReposition(); }, 400);
      return;
    }
  }
  setObserving(true);

  /* ---- thread navigation (]/[) --------------------------------------------- */
  var focusedIdx = -1;
  function jumpThread(dir) {
    if (!comments.length) return;
    focusedIdx = (focusedIdx + dir + comments.length) % comments.length;
    focusBubble(comments[focusedIdx].gid);
  }
  function focusBubble(gid) {
    var b = bubbleEl(gid); if (!b) return;
    if (b._mark && b._mark.scrollIntoView) b._mark.scrollIntoView({ block: "center", behavior: "smooth" });
    var c = getByGid(gid);
    b.style.outline = "2px solid " + (c ? c.color : "#7aa2f7");
    setTimeout(function () { b.style.outline = ""; }, 1200);
  }

  // Click a comment → scroll its passage to center and spotlight it (dim the rest).
  var spotEl = null, spotTimer = null, spotAt = 0;
  function clearSpot() { if (spotTimer) { clearTimeout(spotTimer); spotTimer = null; } if (spotEl) { spotEl.remove(); spotEl = null; } }
  function revealComment(gid) {
    var mark = document.querySelector('mark.glimpse-mark[data-glimpse-gid="' + gid + '"]');
    if (!mark) { focusBubble(gid); return; }            // unanchored → just flash the bubble
    mark.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(function () {                              // place the spotlight after the scroll settles
      clearSpot();
      var r = mark.getBoundingClientRect();
      spotEl = el("div", "spot");
      spotEl.style.left = (r.left - 6) + "px"; spotEl.style.top = (r.top - 4) + "px";
      spotEl.style.width = (r.width + 12) + "px"; spotEl.style.height = (r.height + 8) + "px";
      shadow.appendChild(spotEl); spotAt = Date.now();
      // stays until the user scrolls / clicks away / Esc; 6s safety auto-clear
      spotTimer = setTimeout(function () { if (spotEl) { spotEl.style.opacity = "0"; setTimeout(clearSpot, 300); } }, 6000);
    }, 300);
  }
  function bubbleEl(gid) { return shadow.getElementById("glb-" + gid); }

  /* =========================================================================
   * helpers
   * ======================================================================= */
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function debounce(fn, ms) { var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }
  function uuid() { try { return crypto.randomUUID(); } catch (e) { return "c" + Date.now() + "-" + Math.floor(Math.random() * 1e6); } }
  function getBg() {
    try { var c = getComputedStyle(document.body).backgroundColor; if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c; } catch (e) {}
    return "rgb(255,255,255)";   // assume light when the artifact sets no body background
  }
  function luminance(c) {
    var m = (c || "").match(/(\d+(\.\d+)?)/g); if (!m) return 1;
    var r = +m[0] / 255, g = +m[1] / 255, b = +m[2] / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function hexToRgba(hex, a) {
    var h = hex.replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }
})();
