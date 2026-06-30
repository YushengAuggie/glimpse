/* Glimpse code-explainer renderer. Runs inside the sandboxed (allow-scripts,
 * opaque-origin) artifact iframe. Reads the embedded #glimpse-spec JSON and
 * mounts three views into #glimpse-explain. All agent text is inserted via
 * textContent / DOM nodes — never innerHTML. Pure helpers are exported at the
 * bottom for Node unit tests; the browser ignores that block. */
(function () {
  "use strict";

  // Disable mermaid's auto-run-on-load IMMEDIATELY (this runs during body parse,
  // before DOMContentLoaded). Otherwise mermaid's own DOMContentLoaded handler —
  // registered when mermaid.min.js loaded in <head>, so it fires before us — would
  // auto-render our Data-flow diagram while its tab is still display:none, which
  // collapses it to a 0-size SVG. We render it ourselves when the tab is visible.
  try {
    if (typeof window !== "undefined" && window.mermaid) {
      window.mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });
    }
  } catch (e) { /* mermaid optional */ }

  // ---- pure helpers (tested in Node) --------------------------------------
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
  // Should this composer keydown send? Enter sends; Shift+Enter newlines;
  // Cmd/Ctrl+Enter always sends; an IME-composition Enter (isComposing / keyCode
  // 229, e.g. selecting a CJK candidate) never sends.
  function shouldSend(e) {
    if (!e || e.key !== "Enter") return false;
    if (e.isComposing || e.keyCode === 229) return false;
    if (e.metaKey || e.ctrlKey) return true;
    return !e.shiftKey;
  }

  // Grow a textarea to fit its content (capped at `max`px), unless the user has
  // manually dragged it taller/shorter — then leave their size alone.
  function autoGrow(ta, max) {
    if (!ta || ta._manual) return;
    max = max || 220;
    if (ta._autoH != null && Math.abs(ta.offsetHeight - ta._autoH) > 2) { ta._manual = true; return; }
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, max) + "px";
    ta._autoH = ta.offsetHeight;
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
  var STYLE = [
    "#glimpse-fallback{display:none!important}",
    // Themeable tokens — light defaults; .gx-dark (set when the artifact's body is dark) overrides.
    ".gx{--gx-fg:#1d1d22;--gx-dim:#5b6472;--gx-bg:#fff;--gx-line:#e6e6ee;--gx-accent:#3b5bdb;--gx-accent-fg:#fff;--gx-accent-bg:#eef1ff;--gx-accent-border:#d6ddfb;--gx-soft:#f7f8ff;--gx-pre-bg:#0f1117;--gx-pre-fg:#e6e7ea;",
    "  font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:var(--gx-fg);max-width:1100px;margin:0 auto;padding:18px 20px 80px}",
    ".gx.gx-dark{--gx-fg:#e6e8ee;--gx-dim:#aeb6c6;--gx-bg:#1c2030;--gx-line:#2a3040;--gx-accent:#7aa2f7;--gx-accent-fg:#0f1115;--gx-accent-bg:#222a3f;--gx-accent-border:#33405e;--gx-soft:#171b27;--gx-pre-bg:#0e1118;--gx-pre-fg:#e6e7ea}",
    ".gx-tabs{display:flex;gap:6px;border-bottom:1px solid var(--gx-line);margin-bottom:14px}",
    ".gx-tab{padding:8px 14px;border-radius:8px 8px 0 0;cursor:pointer;font-weight:600;color:var(--gx-dim)}",
    ".gx-tab.on{background:var(--gx-accent);color:var(--gx-accent-fg)}",
    ".gx-tab:focus-visible{outline:2px solid var(--gx-accent);outline-offset:-2px}",
    ".gx-view{display:none}.gx-view.on{display:block}",
    ".gx-card{border:1px solid var(--gx-line);border-radius:12px;padding:14px 16px;margin:10px 0;background:var(--gx-bg)}",
    // Panel column grows by whatever right-edge gutter the comment rail reserves,
    // so the snippet keeps its width (~420px) instead of being eaten by margin-right.
    ".gx-cs{display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,calc(var(--gx-panel,420px) + var(--glimpse-gutter-reserved,0px)));gap:16px}",
    "@media(max-width:1000px){.gx-cs{grid-template-columns:1fr}.gx-panel{position:static!important;max-height:none!important}}",
    ".gx-node{border:1px solid var(--gx-line);border-radius:10px;padding:10px 12px;margin:0 0 16px;cursor:pointer;position:relative}",
    ".gx-node.sel{border-color:var(--gx-accent);background:var(--gx-accent-bg)}",
    ".gx-node:focus-visible,.gx-chip:focus-visible{outline:2px solid var(--gx-accent);outline-offset:2px}",
    ".gx-node .lbl{font-weight:700}.gx-node .loc{font:12px ui-monospace,Menlo,monospace;color:var(--gx-dim)}",
    ".gx-ask{margin-top:8px;font-size:13px;font-weight:600;color:var(--gx-accent-fg);background:var(--gx-accent);border:0;border-radius:7px;padding:6px 11px;cursor:pointer}",
    ".gx-ask:focus-visible{outline:2px solid var(--gx-accent);outline-offset:2px}",
    ".gx-panel{position:sticky;top:8px;align-self:start;border:1px solid var(--gx-line);border-radius:12px;background:var(--gx-bg);max-height:calc(100vh - 24px);overflow:auto;margin-right:calc(var(--glimpse-gutter-reserved,0px))}",
    ".gx-panel pre{background:var(--gx-pre-bg);color:var(--gx-pre-fg);border-radius:8px;padding:12px;overflow:auto;font:12.5px/1.5 ui-monospace,Menlo,monospace}",
    ".gx-panel .tok-kw{color:#9bb7ff}.gx-panel .tok-str{color:#b5e8a0}.gx-panel .tok-com{color:#8b93a7}",
    ".gx-chip{display:inline-block;font-size:12px;background:var(--gx-accent-bg);color:var(--gx-accent);border:1px solid var(--gx-accent-border);border-radius:999px;padding:2px 9px;margin:2px 4px 0 0;cursor:pointer}",
    ".gx-composer{margin-top:8px;border:1px dashed var(--gx-accent-border);border-radius:9px;padding:9px;background:var(--gx-soft);display:none}",
    ".gx-composer.on{display:block}.gx-composer textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:40px;max-height:220px;overflow-y:auto;border:1px solid var(--gx-line);border-radius:7px;padding:7px;font:14px inherit;background:var(--gx-bg);color:var(--gx-fg)}",
    // inline per-node conversation: the user's question + the agent's threaded reply
    ".gx-replies{margin-top:8px;display:none;flex-direction:column;gap:7px}",
    ".gx-replies.on{display:flex}",
    ".gx-reply{font-size:13.5px;line-height:1.5}",
    ".gx-reply .gx-who{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;color:var(--gx-dim);margin-bottom:2px}",
    ".gx-reply-user{color:var(--gx-fg)}",
    ".gx-reply-agent{background:var(--gx-accent-bg);border-left:2px solid var(--gx-accent);border-radius:6px;padding:7px 9px}",
    ".gx-reply-agent p{margin:.3em 0}.gx-reply-agent p:first-child{margin-top:0}.gx-reply-agent p:last-child{margin-bottom:0}",
    ".gx-reply-pending{font-size:12px;color:var(--gx-dim);font-style:italic}"
  ].join("\n");

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  // node id -> the <div.gx-replies> mounted under that node's card. Populated by
  // the call-stack builder; read by the mountNodeReply hook so node-anchored thread
  // turns from the annotate layer render inline next to the right node.
  var nodeReplies = {};

  // Render a node's whole conversation (user question + agent answer, oldest first)
  // into its reply container. User text via textContent; agent text via safeMarkdown
  // (the same trusted markdown path used everywhere else) — never innerHTML.
  function renderNodeReplies(container, turns) {
    container.textContent = "";
    var list = (turns || []).slice().sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    var sawAgent = false;
    list.forEach(function (t) {
      var row = el("div", "gx-reply");
      if (t.role === "agent") {
        sawAgent = true;
        row.className = "gx-reply gx-reply-agent";
        row.appendChild(el("span", "gx-who", "Answer"));
        row.appendChild(safeMarkdown(t.text));
      } else {
        row.className = "gx-reply gx-reply-user";
        row.appendChild(el("span", "gx-who", "You"));
        row.appendChild(document.createTextNode(String(t.text == null ? "" : t.text)));
      }
      container.appendChild(row);
    });
    // user has asked but no agent reply yet → show a quiet pending line.
    var hasUser = list.some(function (t) { return t.role === "user"; });
    if (hasUser && !sawAgent) container.appendChild(el("div", "gx-reply-pending", "Waiting for the agent's reply…"));
    container.classList.toggle("on", list.length > 0);
  }

  // Public hook the annotate layer calls with node-anchored turns. Renders into
  // the per-node container if it exists yet (the call-stack view is mounted);
  // silently no-ops otherwise. Registered only in the browser (Node test imports
  // have no `window` at this point).
  if (typeof window !== "undefined") {
    window.__GLIMPSE_EXPLAIN__ = window.__GLIMPSE_EXPLAIN__ || {};
    window.__GLIMPSE_EXPLAIN__.mountNodeReply = function (nodeId, turns) {
      var container = nodeReplies[nodeId];
      if (!container) return;
      renderNodeReplies(container, turns);
    };
  }

  function renderSnippet(panel, node) {
    panel.textContent = "";
    var hdr = el("div", "gx-phdr");
    hdr.appendChild(el("span", "lbl", node.label || ""));
    hdr.appendChild(el("span", "loc", " " + (node.file || "") + (node.lines ? ":" + node.lines : "")));
    panel.appendChild(hdr);
    if (node.note) panel.appendChild(safeMarkdown(node.note));
    var pre = el("pre"), code = el("code");
    highlightTokens(node.snippet, node.lang).forEach(function (t) {
      var span = el("span", t.cls ? "tok-" + t.cls : null); span.textContent = t.text; code.appendChild(span);
    });
    pre.appendChild(code); panel.appendChild(pre);
  }

  function mount(root, spec) {
    var style = document.createElement("style"); style.textContent = STYLE;
    document.head.appendChild(style);
    var fb = document.getElementById("glimpse-fallback"); if (fb) fb.style.display = "none";

    var wrap = el("div", "gx");
    // Match the artifact's theme: if the page body is dark, flip the renderer dark too.
    try {
      var _bg = getComputedStyle(document.body).backgroundColor, _m = (_bg || "").match(/\d+(\.\d+)?/g);
      if (_m) { var _l = (0.2126 * +_m[0] + 0.7152 * +_m[1] + 0.0722 * +_m[2]) / 255; if (_l < 0.35) wrap.classList.add("gx-dark"); }
    } catch (e) {}
    var darkTheme = wrap.classList.contains("gx-dark");
    var views = [];
    function addView(key, label, build) {
      if (!spec[key]) return;
      var v = el("div", "gx-view"); v.dataset.key = key;
      v.setAttribute("role", "tabpanel"); v.setAttribute("tabindex", "0"); v.setAttribute("aria-label", label);
      build(v); views.push({ key: key, label: label, v: v });
    }
    addView("architecture", "Architecture", function (v) {
      if (spec.architecture.summary) v.appendChild(safeMarkdown(spec.architecture.summary));
      (spec.architecture.components || []).forEach(function (c) {
        var card = el("div", "gx-card");
        card.appendChild(el("div", "lbl", c.name || c.id));
        if (c.role) card.appendChild(el("div", "loc", c.role));
        if (c.note) card.appendChild(safeMarkdown(c.note));
        v.appendChild(card);
      });
    });
    addView("dataflow", "Data flow", function (v) {
      var d = el("div", "mermaid"); var src = mermaidSource(spec.dataflow);
      d.setAttribute("data-src", src);   // keep the pristine source; the div's content gets replaced by the rendered SVG
      d.textContent = src;
      var box = el("div", "gx-card"); box.appendChild(d); v.appendChild(box);
    });
    addView("callstack", "Call stack", function (v) {
      var grid = el("div", "gx-cs"); var list = el("div"); var panel = el("div", "gx-panel");
      panel.appendChild(el("div", null, "Select a node to see its snippet."));
      var steps = (spec.callstack && spec.callstack.steps) || [];
      var byId = {}; steps.forEach(function (s) { byId[s.id] = s; });
      function select(id) {
        var n = byId[id]; if (!n) return;
        list.querySelectorAll(".gx-node").forEach(function (e) {
          var on = e.dataset.id === id; e.classList.toggle("sel", on);
          if (on) e.setAttribute("aria-current", "true"); else e.removeAttribute("aria-current");
        });
        renderSnippet(panel, n);
      }
      steps.forEach(function (s, i) {
        var node = el("div", "gx-node"); node.dataset.id = s.id;
        node.setAttribute("role", "button"); node.tabIndex = 0;
        node.setAttribute("aria-label", "Step " + (i + 1) + ": " + (s.label || s.id));
        node.addEventListener("keydown", function (e) {
          if (e.target === node && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(s.id); }
        });
        node.appendChild(el("span", "lbl", (i + 1) + ". " + (s.label || s.id)));
        node.appendChild(el("div", "loc", (s.file || "") + (s.lines ? ":" + s.lines : "")));
        (s.calls || []).forEach(function (c) {
          var chip = el("span", "gx-chip", (byId[c] ? byId[c].label : c) + " ↗");
          chip.setAttribute("role", "button"); chip.tabIndex = 0;
          chip.setAttribute("aria-label", "Jump to " + (byId[c] ? byId[c].label : c));
          chip.addEventListener("click", function (ev) { ev.stopPropagation(); select(c); });
          chip.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); select(c); } });
          node.appendChild(chip);
        });
        var ask = el("button", "gx-ask", "Ask about this");
        var composer = el("div", "gx-composer");
        var ta = el("textarea"); ta.setAttribute("placeholder", "Ask about this node…  (⏎ send · ⇧⏎ newline)");
        var send = el("button", "gx-ask", "Ask");
        composer.appendChild(ta); composer.appendChild(send);
        // per-node inline conversation; the annotate layer fills this via mountNodeReply
        // once the thread (question + agent reply) is pushed back into the iframe.
        var replies = el("div", "gx-replies"); replies.setAttribute("aria-live", "polite"); nodeReplies[s.id] = replies;
        ask.addEventListener("click", function (ev) { ev.stopPropagation(); composer.classList.toggle("on"); ta.focus(); });
        // Send via the button OR Enter (Shift+Enter newlines; IME Enter never sends).
        var fire = function (ev) {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          var q = ta.value.trim(); if (!q) return;
          var cfg = (typeof window !== "undefined" && window.__GLIMPSE__) || {};
          var rid = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ("gx-" + Date.now());
          window.parent.postMessage(buildAskMessage(s, q, cfg.channelId, rid), "*");
          ta.value = ""; autoGrow(ta); composer.classList.remove("on");
          // optimistic echo: show the question immediately + a pending line. The
          // authoritative thread push (with the agent's answer) replaces this via
          // mountNodeReply once it round-trips back through the annotate layer.
          renderNodeReplies(replies, [{ role: "user", text: q, ts: Date.now() / 1000 }]);
        };
        send.addEventListener("click", fire);
        ta.addEventListener("keydown", function (e) { if (shouldSend(e)) { e.preventDefault(); fire(e); } });
        ta.addEventListener("input", function () { autoGrow(ta); });
        node.appendChild(ask); node.appendChild(composer); node.appendChild(replies);
        node.addEventListener("click", function () { select(s.id); });
        list.appendChild(node);
      });
      grid.appendChild(list); grid.appendChild(panel); v.appendChild(grid);
      if (spec.callstack && spec.callstack.entry) select(spec.callstack.entry);
      else if (steps.length) select(steps[0].id);
    });

    // Mermaid can't lay out a flowchart inside a display:none view (zero-size →
    // a collapsed SVG), so render it lazily the first time the Data flow tab is
    // actually visible, not eagerly at mount.
    var mermaidInit = false, mermaidDone = false, mermaidSeq = 0;
    function renderMermaid() {
      if (mermaidDone || typeof window.mermaid === "undefined") return;
      var dv = views.filter(function (v) { return v.key === "dataflow"; })[0];
      if (!dv || !dv.v.classList.contains("on")) return;   // only once visible
      var node = dv.v.querySelector(".mermaid");
      if (!node) return;
      var src = node.getAttribute("data-src") || node.textContent;   // pristine source, set at build time
      mermaidDone = true;
      try {
        if (!mermaidInit) { window.mermaid.initialize({ startOnLoad: false, theme: darkTheme ? "dark" : "neutral", securityLevel: "strict" }); mermaidInit = true; }
        // Use render() + inject, NOT run(): run() measures the live element in place
        // and collapses to a 0-size SVG inside our grid; render() lays out in mermaid's
        // own sandbox and returns correct geometry. The SVG is mermaid's structured
        // output with strict-escaped, _mmLabel-sanitized labels — safe to inject.
        window.mermaid.render("gx-mermaid-" + (++mermaidSeq), src).then(function (res) {
          node.innerHTML = res.svg;
          if (res.bindFunctions) res.bindFunctions(node);
          wireMermaidClicks(wrap);
        }).catch(function () { mermaidDone = false; });
      } catch (e) { mermaidDone = false; /* fallback: the source text stays visible */ }
    }

    var tabs = el("div", "gx-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Views");
    // Activate a tab: toggle panels + roving tabindex + aria-selected (WAI-ARIA tabs pattern).
    function activateTab(view, moveFocus) {
      tabs.querySelectorAll(".gx-tab").forEach(function (e) {
        var on = e.dataset.key === view.key;
        e.classList.toggle("on", on); e.setAttribute("aria-selected", String(on)); e.tabIndex = on ? 0 : -1;
      });
      views.forEach(function (vv) { vv.v.classList.toggle("on", vv === view); });
      renderMermaid();
      if (moveFocus) { var sel = tabs.querySelector('.gx-tab[aria-selected="true"]'); if (sel) sel.focus(); }
    }
    views.forEach(function (view, idx) {
      var t = el("div", "gx-tab", view.label); t.dataset.key = view.key;
      t.setAttribute("role", "tab"); t.setAttribute("aria-selected", "false"); t.tabIndex = -1;
      t.addEventListener("click", function () { activateTab(view); });
      t.addEventListener("keydown", function (e) {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); activateTab(views[(idx + 1) % views.length], true); }
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); activateTab(views[(idx - 1 + views.length) % views.length], true); }
        else if (e.key === "Home") { e.preventDefault(); activateTab(views[0], true); }
        else if (e.key === "End") { e.preventDefault(); activateTab(views[views.length - 1], true); }
        else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activateTab(view, true); }
      });
      tabs.appendChild(t);
    });
    if (views.length > 1) wrap.appendChild(tabs);
    views.forEach(function (vv) { wrap.appendChild(vv.v); });
    root.appendChild(wrap);

    // default tab: Call stack if present, else first.
    var def = views.filter(function (v) { return v.key === "callstack"; })[0] || views[0];
    if (def) activateTab(def);
    renderMermaid();   // covers the case where Data flow is the default/only view
  }

  function wireMermaidClicks(wrap) {
    // post-render: clicking a dataflow SVG node selects the matching call-stack step.
    wrap.querySelectorAll(".mermaid svg .node").forEach(function (g) {
      g.style.cursor = "pointer";
      g.addEventListener("click", function () {
        var id = (g.id || "").replace(/^flowchart-/, "").replace(/-\d+$/, "");
        var cs = wrap.querySelector('.gx-view[data-key="callstack"]');
        var node = cs && cs.querySelector('.gx-node[data-id="' + (window.CSS ? window.CSS.escape(id) : id) + '"]');
        if (node) { var csTab = wrap.querySelector('.gx-tab[data-key="callstack"]'); if (csTab) csTab.click(); node.click(); node.scrollIntoView({ block: "center" }); }
      });
    });
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    // run only in the browser; tests import without triggering this.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else { boot(); }
    function boot() {
      var specEl = document.getElementById("glimpse-spec");
      var root = document.getElementById("glimpse-explain");
      if (!specEl || !root) return;
      var spec;
      try { spec = JSON.parse(specEl.textContent); }
      catch (e) {
        root.textContent = "Could not parse explain spec.";
        return;
      }
      mount(root, spec);
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { safeMarkdown, mermaidSource, highlightTokens, buildAskMessage, shouldSend };
  }
})();
