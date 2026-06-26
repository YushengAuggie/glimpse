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
  function _mmLabel(s) {
    // NOT full sanitization: `"`→`&quot;` only prevents quoted-label breakout, and
    // we strip init directives + click/href/call. Raw `<`/`&`/`|` are left for
    // Mermaid's securityLevel:'strict' (set at render in Task 6), which is load-bearing.
    return String(s == null ? "" : s)
      .replace(/%%\{[^]*?\}%%/g, " ")   // strip init directives
      .replace(/\b(click|href|call)\b/gi, " ") // strip interaction keywords
      .replace(/"/g, "&quot;")          // Mermaid accepts HTML entities inside quoted labels
      .replace(/[`]/g, "'")
      .replace(/[\r\n]+/g, " ")
      .trim();
  }

  function mermaidSource(df) {
    df = df || {};
    var dir = /^(LR|TB|TD|RL|BT)$/.test(df.direction || "") ? df.direction : "LR";
    var out = ["flowchart " + dir];
    (df.nodes || []).forEach(function (n) {
      out.push("  " + n.id + '["' + _mmLabel(n.label) + '"]');
    });
    (df.edges || []).forEach(function (e) {
      var lbl = _mmLabel(e.label);
      out.push("  " + e.from + (lbl ? ' -->|"' + lbl + '"| ' : " --> ") + e.to);
    });
    return out.join("\n");
  }
  var _KW = /\b(function|def|return|if|else|elif|for|while|local|const|let|var|class|import|from|raise|try|except|echo|true|false|null|None|True|False)\b/;
  function highlightTokens(code, lang) {
    var s = String(code == null ? "" : code);
    var toks = [];
    // master regex: line-comment (# or //), then string ("..." or '...'), then word.
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
  function buildAskMessage(node, question, channelId, randomId) {
    return {
      type: "glimpse:annotate", v: 1, channelId: channelId, intent: "ask",
      clientTurnId: randomId,
      anchor: { kind: "node", id: node.id, label: node.label || "", file: node.file || "", lines: node.lines || "" },
      quote: String(node.snippet == null ? "" : node.snippet).slice(0, 4000),
      text: String(question == null ? "" : question)
    };
  }

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
