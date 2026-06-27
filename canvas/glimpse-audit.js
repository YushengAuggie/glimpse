/*
 * glimpse-audit.js — render-correctness auditor (the in-artifact half).
 * =============================================================================
 * Injected at render time into the sandboxed artifact iframe (same as the
 * highlight-chat helper). After fonts load and layout settles, it audits the
 * REAL browser render for the things that make an artifact unreadable —
 * horizontal overflow, clipped text, and overlapping text — and posts the
 * findings UP to the shell (validated by the per-iframe channelId). The agent
 * reads them with `glimpse audit <slug>` and fixes the layout BEFORE a human
 * reviews it. Inspired by lavish-axi's layout_warnings loop.
 *
 * Pure scoring helpers are exported for Node unit tests; the browser ignores
 * that block. All values posted are plain data (selectors + numbers), never DOM.
 * =============================================================================
 */
(function () {
  "use strict";

  var ERROR_OVERFLOW_PX = 4;      // overflow beyond this is an error, not a sub-pixel nit
  var MAX_ELEMENTS = 1500;        // cap the element walk for perf on huge artifacts
  var MAX_TEXT_LEAVES = 220;      // overlap check is pairwise; bound it
  var MAX_FINDINGS = 40;

  /* ---- pure helpers (tested in Node) -------------------------------------- */
  function severityFor(overflowPx) { return overflowPx > ERROR_OVERFLOW_PX ? "error" : "warning"; }

  function pageOverflowFinding(scrollWidth, viewportWidth) {
    var px = Math.round(scrollWidth - viewportWidth);
    if (px <= ERROR_OVERFLOW_PX) return null;
    return { selector: "html", kind: "page-horizontal-overflow", overflowPx: px, severity: "error" };
  }

  // Decide what (if anything) is wrong with one element's box metrics.
  // metrics: {selector, scrollWidth, clientWidth, scrollHeight, clientHeight, overflowX, overflowY}
  function elementOverflowFinding(m) {
    var clip = function (o) { return o === "hidden" || o === "clip"; };
    var scroller = function (o) { return o === "auto" || o === "scroll"; };
    var hPx = m.clientWidth > 0 ? Math.round(m.scrollWidth - m.clientWidth) : 0;
    var vPx = m.clientHeight > 0 ? Math.round(m.scrollHeight - m.clientHeight) : 0;
    // text cut off by an overflow:hidden/clip box is the worst case — always an error
    if (hPx > ERROR_OVERFLOW_PX && clip(m.overflowX)) {
      return { selector: m.selector, kind: "clipped-text", overflowPx: hPx, severity: "error" };
    }
    if (vPx > ERROR_OVERFLOW_PX && clip(m.overflowY)) {
      return { selector: m.selector, kind: "clipped-text", overflowPx: vPx, severity: "error" };
    }
    // content spills out of a non-scrolling, non-clipping box → visible mess
    if (hPx > ERROR_OVERFLOW_PX && !scroller(m.overflowX)) {
      return { selector: m.selector, kind: "element-overflow", overflowPx: hPx, severity: severityFor(hPx) };
    }
    return null;
  }

  function intersectionArea(a, b) {
    var x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    var y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return x * y;
  }
  function rectArea(r) { return Math.max(0, r.width) * Math.max(0, r.height); }

  // Two text boxes overlap enough to be unreadable? (ignore tiny incidental touches)
  function overlapFinding(a, b, selA, selB) {
    var inter = intersectionArea(a, b);
    if (inter < Math.min(rectArea(a) * 0.25, 24)) return null;
    return { selector: selA + " ∩ " + selB, kind: "overlapping-text", overflowPx: Math.round(inter), severity: "error" };
  }

  /* ---- browser entry ------------------------------------------------------ */
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    var CFG = window.__GLIMPSE__ || {};
    var CHANNEL = CFG.channelId || null;
    if (!window.__glimpse_audit_loaded) {
      window.__glimpse_audit_loaded = true;

      var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, HEAD: 1, META: 1, LINK: 1, BR: 1, svg: 0 };

      function inOwnUI(el) {
        // Skip Glimpse's OWN injected chrome — the highlight-chat <mark> overlays and
        // their numbered <sup> badges, plus the Shadow-DOM layer host. Auditing them
        // would flag the annotation UI (which sits over the text it wraps) as overlap.
        return !!(el.closest && (
          el.closest("#__glimpse_layer") || el.closest("[data-glimpse-audit]") ||
          el.closest("mark.glimpse-mark") || el.closest("sup.glimpse-badge")
        ));
      }
      function visible(el, rect) {
        if (rect.width <= 0 || rect.height <= 0) return false;
        var s = getComputedStyle(el);
        return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
      }
      // short, readable CSS-ish path: tag#id or tag:nth-of-type, up to 4 hops
      function selectorFor(el) {
        var parts = [], depth = 0, n = el;
        while (n && n.nodeType === 1 && n.tagName !== "BODY" && depth < 4) {
          var seg = n.tagName.toLowerCase();
          if (n.id) { parts.unshift(seg + "#" + n.id); break; }
          var i = 1, sib = n;
          while ((sib = sib.previousElementSibling)) if (sib.tagName === n.tagName) i++;
          parts.unshift(seg + ":nth-of-type(" + i + ")");
          n = n.parentElement; depth++;
        }
        return (depth >= 4 ? "… " : "") + parts.join(" > ");
      }
      function hasOwnText(el) {
        for (var c = el.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 3 && c.nodeValue && c.nodeValue.trim()) return true;
        }
        return false;
      }

      function auditLayout() {
        var vw = document.documentElement.clientWidth;
        var findings = [], seen = {};
        function push(f) {
          if (!f) return;
          var key = f.kind + "|" + f.selector;
          if (seen[key]) return; seen[key] = 1;
          if (findings.length < MAX_FINDINGS) findings.push(f);
        }
        push(pageOverflowFinding(document.documentElement.scrollWidth, vw));

        var all = document.body ? document.body.querySelectorAll("*") : [];
        var leaves = [];
        for (var i = 0; i < all.length && i < MAX_ELEMENTS; i++) {
          var el = all[i];
          if (SKIP_TAGS[el.tagName]) continue;
          if (inOwnUI(el)) continue;
          var rect = el.getBoundingClientRect();
          if (!visible(el, rect)) continue;
          var cs = getComputedStyle(el);
          push(elementOverflowFinding({
            selector: selectorFor(el),
            scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
            scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
            overflowX: cs.overflowX, overflowY: cs.overflowY
          }));
          if (hasOwnText(el) && leaves.length < MAX_TEXT_LEAVES) leaves.push({ el: el, rect: rect });
        }
        // overlapping text — bounded pairwise among text-bearing leaves
        for (var a = 0; a < leaves.length; a++) {
          for (var b = a + 1; b < leaves.length; b++) {
            if (leaves[a].el.contains(leaves[b].el) || leaves[b].el.contains(leaves[a].el)) continue;
            push(overlapFinding(leaves[a].rect, leaves[b].rect, selectorFor(leaves[a].el), selectorFor(leaves[b].el)));
            if (findings.length >= MAX_FINDINGS) break;
          }
          if (findings.length >= MAX_FINDINGS) break;
        }
        return { viewportWidth: vw, findings: findings };
      }

      var lastSig = null;
      function run() {
        var res;
        try { res = auditLayout(); } catch (e) { return; }
        var sig = JSON.stringify(res.findings);
        if (sig === lastSig) return;          // only post when the picture changes
        lastSig = sig;
        try {
          window.parent.postMessage({
            type: "glimpse:layout", v: 1, channelId: CHANNEL,
            viewportWidth: res.viewportWidth, findings: res.findings, ts: Date.now()
          }, "*");
        } catch (e) {}
      }

      var t = null;
      function schedule(delay) { clearTimeout(t); t = setTimeout(run, delay); }

      // first pass once fonts + layout settle; then on resize and DOM-quiet.
      function start() {
        var go = function () { schedule(150); };
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(go, go); else go();
        window.addEventListener("resize", function () { lastSig = null; schedule(250); });
        try {
          var mo = new MutationObserver(function (recs) {
            for (var i = 0; i < recs.length; i++) {
              var tg = recs[i].target;
              if (tg && tg.nodeType === 1 && inOwnUI(tg)) continue;   // ignore our own UI churn
              schedule(400); return;
            }
          });
          mo.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
        } catch (e) {}
      }
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
      else start();
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { severityFor, pageOverflowFinding, elementOverflowFinding, intersectionArea, rectArea, overlapFinding, ERROR_OVERFLOW_PX };
  }
})();
