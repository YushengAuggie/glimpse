/* Glimpse code-explainer renderer. Runs inside the sandboxed (allow-scripts,
 * opaque-origin) artifact iframe. Reads the embedded #glimpse-spec JSON and
 * mounts three views into #glimpse-explain. All agent text is inserted via
 * textContent / DOM nodes — never innerHTML. Pure helpers are exported at the
 * bottom for Node unit tests; the browser ignores that block. */
(function () {
  "use strict";

  // ---- pure helpers (tested in Node) --------------------------------------
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function safeMarkdown(/* md */) { return document.createDocumentFragment(); } // Task 2
  function mermaidSource(/* dataflow */) { return ""; }                         // Task 3
  function highlightTokens(/* code, lang */) { return []; }                     // Task 4
  function buildAskMessage(/* node, question, channelId, randomId */) { return {}; } // Task 5

  // ---- browser entry (Task 6) ---------------------------------------------
  function mount(/* root, spec */) { /* Task 6 */ }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    // run only in the browser; tests import without triggering this.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else { boot(); }
    function boot() {
      var el = document.getElementById("glimpse-spec");
      var root = document.getElementById("glimpse-explain");
      if (!el || !root) return;
      var spec;
      try { spec = JSON.parse(el.textContent); }
      catch (e) {
        root.textContent = "Could not parse explain spec.";
        return;
      }
      mount(root, spec);
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { escapeHtml, safeMarkdown, mermaidSource, highlightTokens, buildAskMessage };
  }
})();
