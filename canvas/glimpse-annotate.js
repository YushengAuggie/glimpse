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
  var questions = {};   // cid -> {cid, anchor, quote, text, status, answer, num, color, unanchored}
  var order = [];       // cids in creation order (drives the numbered badges)

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
    "  box-shadow:0 4px 16px rgba(0,0,0," + (dark ? ".45" : ".12") + "); overflow:hidden;",
    "  transition:max-height .12s ease-out; }",
    ".bubble .hd{ display:flex; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid " + (dark ? "#2a3040" : "#eef0f6") + "; }",
    ".badge{ flex:0 0 auto; width:18px; height:18px; border-radius:5px; color:#fff; font-weight:700;",
    "  font-size:11px; display:flex; align-items:center; justify-content:center; }",
    ".quote{ flex:1; min-width:0; font-size:11.5px; opacity:.75; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }",
    ".body{ padding:8px 10px; display:flex; flex-direction:column; gap:8px; max-height:340px; overflow:auto; }",
    ".turn{ font-size:13px; }",
    ".turn.u{ opacity:.92; }",
    ".turn.a{ background:" + hexToRgba(dark ? "#7aa2f7" : "#3b5bdb", dark ? 0.1 : 0.07) + "; padding:7px 9px; border-radius:6px; }",
    ".q{ font-weight:600; }",
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
    ".more{ background:none; border:0; color:" + (dark ? "#7aa2f7" : "#3b5bdb") + "; padding:2px; font-size:12px; cursor:pointer; align-self:flex-start; }",
    ".toolbar{ position:fixed; pointer-events:auto; z-index:2147483647; display:none;",
    "  background:" + (dark ? "#1c2030" : "#1a1d24") + "; border-radius:7px; box-shadow:0 4px 14px rgba(0,0,0,.4); }",
    ".toolbar button{ background:transparent; color:#fff; border:0; padding:6px 12px; font-weight:600; }",
    ".toolbar button:focus-visible{ outline:2px solid #7aa2f7; outline-offset:-2px; }",
    ".hint{ position:fixed; right:16px; bottom:16px; pointer-events:none; z-index:2147483646;",
    "  background:" + (dark ? "rgba(28,32,48,.95)" : "rgba(26,29,36,.92)") + "; color:#fff; font-size:12px;",
    "  padding:7px 12px; border-radius:7px; transition:opacity .4s; }",
    ".inline{ display:block; margin:8px 0; pointer-events:auto; }"
  ].join("\n");
  shadow.appendChild(style);

  var rail = el("div", "rail"); shadow.appendChild(rail);
  var toolbar = el("div", "toolbar"); toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Annotation actions");
  var askBtn = el("button"); askBtn.textContent = "Ask"; askBtn.type = "button";
  toolbar.appendChild(askBtn); shadow.appendChild(toolbar);

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
    if (e.key === "Escape") hideToolbar();
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

  askBtn.addEventListener("click", function () {
    if (!pendingRange) return;
    var anchor = captureAnchor(pendingRange);
    // Prefer the anchor's clean `exact` (badge digits excluded) over the raw
    // selection string for the displayed quote.
    var quote = (anchor && anchor.exact) ? anchor.exact : pendingRange.toString();
    hideToolbar();
    openComposer(anchor, quote);
  });

  function openComposer(anchor, quote) {
    var cid = uuid();
    var num = order.length + 1;
    var color = hueFor(order.length);
    questions[cid] = { cid: cid, anchor: anchor, quote: quote, text: "", status: "composing", answers: [], num: num, color: color, unanchored: !anchor };
    order.push(cid);
    renderAll();
    var b = bubbleEl(cid); if (!b) return;
    var ta = b.querySelector("textarea"); if (ta) { ta.focus(); }
  }

  /* =========================================================================
   * 4. Rendering — marks + bubbles, driven by `questions`
   * ======================================================================= */
  var repositionQueued = false, narrowMode = false;
  function renderAll() {
    setObserving(false);
    unwrapMarks();
    var model = buildSegments();
    narrowMode = window.innerWidth < (700 + GUTTER_W);   // no room for a side rail → callouts under the line
    rail.textContent = "";
    var firstMarks = {};
    // place marks
    for (var i = 0; i < order.length; i++) {
      var q = questions[order[i]];
      q.unanchored = false;
      if (q.anchor) {
        var span = resolveAnchor(q.anchor, model);
        if (span) {
          var first = markRange(model, span[0], span[1], q.cid, tint(q.color));
          if (first) {
            firstMarks[q.cid] = first;
            first.setAttribute("aria-describedby", "glb-" + q.cid);
            first.tabIndex = 0; first.setAttribute("role", "button");
            first.setAttribute("aria-label", "Annotation " + q.num + " — open discussion");
            (function (cid) {
              first.addEventListener("click", function () { focusBubble(cid); });
              first.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); focusBubble(cid); } });
            })(q.cid);
            addBadge(first, q.num, q.color);
          } else q.unanchored = true;
        } else q.unanchored = true;
      } else q.unanchored = true;
    }
    setTimeout(function () { setObserving(true); }, 0);
    // build bubbles
    for (var j = 0; j < order.length; j++) {
      renderBubble(questions[order[j]], narrowMode, firstMarks[order[j]]);
    }
    queueReposition();
  }

  function renderBubble(q, narrow, firstMark) {
    var b = el("div", "bubble"); b.id = "glb-" + q.cid;
    b.setAttribute("role", "complementary");
    b.setAttribute("aria-label", "Discussion " + q.num + ": " + (q.quote || "selection").slice(0, 60));
    b.tabIndex = -1;
    // header
    var hd = el("div", "hd");
    var badge = el("div", "badge"); badge.style.background = q.color; badge.textContent = String(q.num);
    var quote = el("div", "quote"); quote.textContent = q.quote || "(selection)";
    hd.appendChild(badge); hd.appendChild(quote);
    if (q.unanchored) { var w = el("span", "tag warn"); w.textContent = "passage changed"; hd.appendChild(w); }
    b.appendChild(hd);
    // body
    var body = el("div", "body");
    if (q.status === "composing") {
      var ta = document.createElement("textarea");
      ta.setAttribute("aria-label", "Your question about the selected text");
      ta.placeholder = "Ask about this…";
      ta.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(q.cid, ta.value); }
      });
      var qline = el("div"); var qq = el("div", "turn u"); var qs = el("span", "q"); qs.textContent = "❝" + (q.quote || "selection") + "❞"; qq.appendChild(qs); qline.appendChild(qq);
      body.appendChild(qline);
      body.appendChild(ta);
      var row = el("div", "row");
      var cancel = el("button", "ghost"); cancel.textContent = "Cancel"; cancel.addEventListener("click", function () { dropQuestion(q.cid); });
      var send = el("button", "primary"); send.textContent = "Ask"; send.addEventListener("click", function () { submit(q.cid, ta.value); });
      row.appendChild(cancel); row.appendChild(send); body.appendChild(row);
    } else {
      // question turn
      var ut = el("div", "turn u"); var us = el("span", "q"); us.textContent = q.text; ut.appendChild(us); body.appendChild(ut);
      var ans = q.answers || [];
      // collapse: when a thread grows past COLLAPSE_AFTER, hide older answers behind a toggle
      var start = 0;
      if (ans.length + 1 > COLLAPSE_AFTER && !q._expanded) start = ans.length - (COLLAPSE_AFTER - 1);
      if (start > 0) {
        var more = el("button", "more"); more.textContent = "Show " + start + " earlier";
        more.addEventListener("click", function () { q._expanded = true; renderAll(); });
        body.appendChild(more);
      }
      for (var ai = start; ai < ans.length; ai++) {
        var at = el("div", "turn a"); at.textContent = ans[ai]; body.appendChild(at);
      }
      if (!ans.length) {
        if (q.status === "unsent") {                 // ack watchdog fired — let the user retry
          var w = el("div", "meta"); var wt = el("span", "tag warn"); wt.textContent = "not sent"; w.appendChild(wt);
          var retry = el("button", "ghost"); retry.textContent = "Retry";
          retry.addEventListener("click", function () { submit(q.cid, q.text); });
          w.appendChild(retry); body.appendChild(w);
        } else {
          var pend = el("div", "meta");
          if (!bridgeLive) { var off = el("span", "tag off"); off.textContent = "agent offline"; pend.appendChild(off); }
          else { var dots = el("div", "dots" + (q.status === "acknowledged" ? " ack" : "")); dots.appendChild(el("span")); dots.appendChild(el("span")); dots.appendChild(el("span")); pend.appendChild(dots); }
          var ago = el("span"); ago.textContent = q.status === "acknowledged" ? "  sent · waiting" : "  asked"; pend.appendChild(ago);
          body.appendChild(pend);
        }
      }
    }
    b.appendChild(body);
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
          b.style.left = (r ? Math.max(8, Math.min(r.left, vw - w - 8)) : 8) + "px";
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
  window.addEventListener("scroll", queueReposition, true);
  window.addEventListener("resize", function () { renderAll(); });

  /* =========================================================================
   * 5. Submit + messaging (validated postMessage to/from the shell)
   * ======================================================================= */
  function submit(cid, value) {
    var q = questions[cid]; if (!q) return;
    var text = (value || "").trim(); if (!text) return;
    q.text = text; q.status = "pending";
    renderAll();
    post({ type: "glimpse:annotate", v: 1, channelId: CHANNEL, intent: "ask",
           clientTurnId: cid, anchor: q.anchor, quote: q.quote, text: text });
    // ack watchdog: if the shell never acks, surface a retry hint
    q._ackTimer = setTimeout(function () {
      if (questions[cid] && questions[cid].status === "pending") { questions[cid].status = "unsent"; renderAllSoft(); }
    }, 3000);
  }
  function dropQuestion(cid) {
    delete questions[cid];
    var i = order.indexOf(cid); if (i >= 0) order.splice(i, 1);
    renderAll();
  }
  function post(msg) { try { window.parent.postMessage(msg, "*"); } catch (e) {} }

  window.addEventListener("message", function (e) {
    // Trust gate: must be the shell (parent), the canvas origin, our channel.
    if (e.source !== window.parent) return;
    if (PARENT_ORIGIN && e.origin !== PARENT_ORIGIN) return;
    var d = e.data; if (!d || d.channelId !== CHANNEL) return;
    if (d.type === "glimpse:annotate:ack") {
      var q = questions[d.clientTurnId];
      if (q) { if (q._ackTimer) clearTimeout(q._ackTimer); if (q.status === "pending") { q.status = "acknowledged"; renderAllSoft(); } }
    } else if (d.type === "glimpse:thread") {
      ingestThread(d.turns || []);
    } else if (d.type === "glimpse:liveness") {
      bridgeLive = d.state !== "offline"; renderAllSoft();
    }
  });

  // The thread file is authoritative: reconcile persisted turns into local state.
  function ingestThread(turns) {
    var users = [], agentByReply = {};
    for (var i = 0; i < turns.length; i++) {
      var t = turns[i];
      if (t.role === "user") users.push(t);
      else if (t.role === "agent" && t.replyTo) { (agentByReply[t.replyTo] = agentByReply[t.replyTo] || []).push(t); }
    }
    for (var u = 0; u < users.length; u++) {
      var t2 = users[u];
      var cid = t2.clientTurnId || t2.id;
      var q = questions[cid];
      if (!q) {
        var num = order.length + 1, color = hueFor(order.length);
        q = questions[cid] = { cid: cid, anchor: t2.anchor, quote: t2.quote, text: t2.text, status: "pending", answers: [], num: num, color: color, unanchored: false };
        order.push(cid);
      }
      q.anchor = t2.anchor || q.anchor; q.quote = t2.quote || q.quote; q.text = t2.text || q.text;
      var alist = agentByReply[t2.id] || [];
      q.answers = alist.map(function (x) { return x.text; });   // render every reply, in order
      if (q.answers.length) q.status = "answered";
      else if (q.status === "composing") q.status = "pending";
    }
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
      reanchorTimer = setTimeout(function () { if (order.length) renderAll(); else queueReposition(); }, 400);
      return;
    }
  }
  setObserving(true);

  /* ---- thread navigation (]/[) --------------------------------------------- */
  var focusedIdx = -1;
  function jumpThread(dir) {
    if (!order.length) return;
    focusedIdx = (focusedIdx + dir + order.length) % order.length;
    focusBubble(order[focusedIdx]);
  }
  function focusBubble(cid) {
    var b = bubbleEl(cid); if (!b) return;
    if (b._mark && b._mark.scrollIntoView) b._mark.scrollIntoView({ block: "center", behavior: "smooth" });
    b.style.outline = "2px solid " + (questions[cid] ? questions[cid].color : "#7aa2f7");
    setTimeout(function () { b.style.outline = ""; }, 1200);
  }
  function bubbleEl(cid) { return shadow.getElementById("glb-" + cid); }

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
