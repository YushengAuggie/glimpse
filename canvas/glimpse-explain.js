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

  function appendInline(parent, text) {
    // tokenize inline marks on already-untrusted text; emit DOM nodes only.
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
          parent.appendChild(document.createTextNode(m[7])); // inert: keep literal "[x](url)"
        }
      }
      i = re.lastIndex;
    }
    if (i < text.length) parent.appendChild(document.createTextNode(text.slice(i)));
  }

  function safeMarkdown(md) {
    var frag = document.createDocumentFragment();
    var lines = String(md == null ? "" : md).split("\n");
    var list = null;
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
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
        // skip blank lines (paragraph break handled implicitly)
      } else {
        var p = document.createElement("p"); appendInline(p, line); frag.appendChild(p);
      }
    }
    return frag;
  }
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
