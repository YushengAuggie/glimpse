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
  var CFG = window.__GLIMPSE__;
  // Bail unless the shell injected a config and annotation is enabled. Running
  // twice (e.g. double-injection) is a no-op.
  if (!CFG || !CFG.channelId || CFG.annotate === false || window.__glimpse_annotate_loaded) return;
  window.__glimpse_annotate_loaded = true;

  var CHANNEL = CFG.channelId;
  var PARENT_ORIGIN = CFG.origin || "";   // the canvas origin, e.g. http://127.0.0.1:4321
  var SLUG = CFG.slug || "";
  var MIN_SELECTION = 10;                 // chars; below this the toolbar stays hidden (anti-noise)
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
  function anchorKey(a) { return (a && a.exact) ? ("a:" + a.exact + "#" + (a.occurrence || 0)) : null; }
  function getByGid(gid) { for (var i = 0; i < comments.length; i++) if (comments[i].gid === gid) return comments[i]; return null; }
  function newComment(anchor, quote) {
    var c = { gid: "c" + (++gidSeq), key: anchorKey(anchor), anchor: anchor || null, quote: quote || "",
              num: comments.length + 1, color: hueFor(comments.length), unanchored: !anchor,
              state: "composing", turns: [], draft: "", _expanded: false };
    comments.push(c); if (c.key) byKey[c.key] = c;
    return c;
  }
  // A textarea bound to the comment's draft. Enter inserts a NEWLINE (never sends);
  // sending is the button's job only.
  function mkInput(c, placeholder) {
    var ta = document.createElement("textarea");
    ta.setAttribute("aria-label", "Your message about the selected passage");
    ta.placeholder = placeholder;
    ta.value = c.draft || "";
    ta.addEventListener("input", function () { c.draft = ta.value; });
    return ta;
  }
  // Wire a textarea + Send button: disable Send when empty, send on Cmd/Ctrl+Enter
  // (plain Enter still newlines), and guard against double-send (rapid clicks).
  function wireSend(c, ta, btn) {
    var refresh = function () { btn.disabled = !ta.value.trim(); };
    var fire = function () { if (btn.disabled) return; btn.disabled = true; sendTurn(c, ta.value); };
    ta.addEventListener("input", refresh);
    ta.addEventListener("keydown", function (e) { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); fire(); } });
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
    "  background:" + (dark ? "#1c2030" : "#ffffff") + "; color:" + (dark ? "#e6e8ee" : "#1a1d24") + ";",
    "  border:1px solid " + (dark ? "#2a3040" : "#e3e6ee") + "; border-radius:8px;",
    "  box-shadow:0 4px 16px rgba(0,0,0," + (dark ? ".45" : ".12") + ");",
    "  max-height:calc(100vh - 56px); overflow-y:auto;",   // tall threads scroll inside so the reply box stays reachable",
    "  transition:max-height .12s ease-out; }",
    ".bubble .hd{ display:flex; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid " + (dark ? "#2a3040" : "#eef0f6") + "; }",
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
    "textarea{ width:100%; box-sizing:border-box; resize:vertical; min-height:46px; font:inherit;",
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
    if (!txt || txt.trim().length < MIN_SELECTION) { hideToolbar(); return; }
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
    queueReposition();
  }

  function renderBubble(c, narrow, firstMark) {
    var b = el("div", "bubble"); b.id = "glb-" + c.gid;
    b.setAttribute("role", "complementary");
    b.setAttribute("aria-label", "Discussion " + c.num + ": " + (c.quote || "selection").slice(0, 60));
    b.tabIndex = -1;
    var hd = el("div", "hd");
    var badge = el("div", "badge"); badge.style.background = c.color; badge.textContent = String(c.num);
    var quote = el("div", "quote"); quote.textContent = c.quote || "(selection)";
    hd.appendChild(badge); hd.appendChild(quote);
    if (c.unanchored) { var w = el("span", "tag warn"); w.textContent = "passage changed"; hd.appendChild(w); }
    b.appendChild(hd);

    var body = el("div", "body");
    if (c.state === "composing") {
      // initial composer: quote preview + textarea (Enter = newline) + Cancel / Ask
      var qq = el("div", "turn u"); var qs = el("span", "q"); qs.textContent = "❝" + (c.quote || "selection") + "❞"; qq.appendChild(qs);
      body.appendChild(qq);
      var ta = mkInput(c, "Ask about this…  (⌘⏎ to send)"); body.appendChild(ta);
      var row = el("div", "row");
      var cancel = el("button", "ghost"); cancel.textContent = "Cancel"; cancel.addEventListener("click", function () { dropComment(c); });
      var ask = el("button", "primary"); ask.textContent = "Ask";
      row.appendChild(cancel); row.appendChild(ask); body.appendChild(row);
      wireSend(c, ta, ask);
    } else {
      // the growing conversation: user / agent / user / agent …
      var turns = c.turns || [];
      var start = 0;
      if (turns.length > COLLAPSE_AFTER && !c._expanded) start = turns.length - COLLAPSE_AFTER;
      if (start > 0) {
        var more = el("button", "more"); more.textContent = "Show " + start + " earlier";
        more.addEventListener("click", function () { c._expanded = true; renderAll(); });
        body.appendChild(more);
      }
      for (var i = start; i < turns.length; i++) {
        var t = turns[i];
        if (t.role === "agent") { var at = el("div", "turn a"); at.textContent = t.text; body.appendChild(at); continue; }
        // user turn
        var ut = el("div", "turn u"); var usp = el("span", "q"); usp.textContent = t.text; ut.appendChild(usp); body.appendChild(ut);
        var answered = t.status === "answered" || (turns[i + 1] && turns[i + 1].role === "agent");
        if (!answered) {
          if (t.status === "unsent") {   // always actionable, wherever it sits
            var wm = el("div", "meta"); var wt = el("span", "tag warn"); wt.textContent = "not sent"; wm.appendChild(wt);
            var rt = el("button", "ghost"); rt.textContent = "Retry";
            (function (tt) { rt.addEventListener("click", function () { tt.status = "pending"; renderAll(); resendTurn(c, tt); }); })(t);
            wm.appendChild(rt); body.appendChild(wm);
          } else if (i === turns.length - 1) {   // pending/offline only on the latest turn (avoid stacked "agent offline")
            var pend = el("div", "meta");
            if (!bridgeLive) { var off = el("span", "tag off"); off.textContent = "agent offline"; pend.appendChild(off); }
            else { var dots = el("div", "dots" + (t.status === "acknowledged" ? " ack" : "")); dots.appendChild(el("span")); dots.appendChild(el("span")); dots.appendChild(el("span")); pend.appendChild(dots); }
            var ago = el("span"); ago.textContent = t.status === "acknowledged" ? "  sent · waiting" : "  asked"; pend.appendChild(ago);
            body.appendChild(pend);
          }
        }
      }
      if (c._expanded && turns.length > COLLAPSE_AFTER) {
        var less = el("button", "more"); less.textContent = "Show less";
        less.addEventListener("click", function () { c._expanded = false; renderAll(); });
        body.appendChild(less);
      }
      // follow-up box — keep the conversation going. Enter = newline; Send sends.
      var fta = mkInput(c, "Reply…  (Enter = new line, ⌘⏎ to send)"); body.appendChild(fta);
      var frow = el("div", "row");
      var send = el("button", "primary"); send.textContent = "Send";
      frow.appendChild(send); body.appendChild(frow);
      wireSend(c, fta, send);
    }
    b.appendChild(body);
    b.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest("button, textarea, .more")) return;
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
      var lastBottom = 8, vw = window.innerWidth;
      for (var i = 0; i < bubbles.length; i++) {
        var b = bubbles[i], mark = b._mark, top;
        var r = mark ? mark.getBoundingClientRect() : null;
        if (narrowMode) {
          // No side room: render each bubble as a callout just under its highlighted line.
          var w = Math.min(GUTTER_W - 24, vw - 24);
          b.style.width = w + "px"; b.style.right = "auto";
          top = r ? r.bottom + 6 : lastBottom + 4;
          if (top < lastBottom) top = lastBottom;
          // `left` is relative to the fixed rail (its left edge sits at vw-GUTTER_W),
          // so translate the desired viewport-x back into rail coordinates.
          var vx = r ? Math.max(8, Math.min(r.left, vw - w - 8)) : 8;
          b.style.left = (vx - (vw - GUTTER_W)) + "px";
        } else {
          b.style.right = "12px"; b.style.left = "auto"; b.style.width = "";
          top = r ? r.top : lastBottom + 4;   // unanchored → flow under the previous
          if (top < lastBottom) top = lastBottom;
        }
        b.style.top = top + "px";
        lastBottom = top + b.offsetHeight + 10;
      }
    });
  }
  window.addEventListener("scroll", function () { queueReposition(); if (spotEl && Date.now() - spotAt > 500) clearSpot(); }, true);   // guard skips our own scrollIntoView
  // Clicks inside the shadow UI retarget to the host (#__glimpse_layer) at the
  // document level, so guard on the host id, not ".bubble".
  document.addEventListener("mousedown", function (e) { if (spotEl && !(e.target.closest && e.target.closest("#__glimpse_layer, mark.glimpse-mark"))) clearSpot(); }, true);
  window.addEventListener("resize", function () { renderAll(); });

  /* =========================================================================
   * 5. Submit + messaging (validated postMessage to/from the shell)
   * ======================================================================= */
  // Append a user turn to a comment and send it up. Works for the first ask AND
  // every follow-up — the conversation just keeps growing.
  function sendTurn(c, value) {
    var text = (value || "").trim(); if (!text) return;
    var cid = uuid();
    var turn = { role: "user", text: text, status: "pending", cid: cid, _optimistic: true, ts: Date.now() / 1000 };
    c.turns.push(turn); c.state = "open"; c.draft = "";
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
        if (!c) c = newComment(u.anchor, u.quote);
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
