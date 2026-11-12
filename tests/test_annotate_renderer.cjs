// Unit tests for the pure helpers exported by canvas/glimpse-annotate.js.
// The annotate module is a browser IIFE that bails without a __GLIMPSE__ config,
// but it exports its DOM-only markdown + key helpers before that bail so they can
// be tested here with the same minimal DOM shim the explain renderer test uses.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const shim = require("./dom-shim.cjs");
global.window = shim.window; global.document = shim.document;
const AN = require(path.join(__dirname, "..", "canvas", "glimpse-annotate.js"));

function frag2html(frag) {
  const d = document.createElement("div"); d.appendChild(frag); return d.innerHTML;
}

test("module exports the pure helpers", () => {
  for (const fn of ["safeMarkdown", "appendInline", "shouldSend"]) {
    assert.strictEqual(typeof AN[fn], "function", "missing export: " + fn);
  }
});

test("safeMarkdown renders inline marks as elements, not raw", () => {
  const html = frag2html(AN.safeMarkdown("a **b** and `c` and *d*"));
  assert.match(html, /<strong>b<\/strong>/);
  assert.match(html, /<code>c<\/code>/);
  assert.match(html, /<em>d<\/em>/);
});

test("safeMarkdown escapes embedded HTML (no innerHTML parsing of agent text)", () => {
  const html = frag2html(AN.safeMarkdown("x <script>alert(1)</script>"));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("safeMarkdown allows http/mailto links, rejects javascript:", () => {
  const ok = frag2html(AN.safeMarkdown("[g](https://x.dev)"));
  assert.match(ok, /<a href="https:\/\/x\.dev"[^>]*>g<\/a>/);
  const bad = frag2html(AN.safeMarkdown("[x](javascript:alert(1))"));
  assert.doesNotMatch(bad, /href="javascript:/);
  assert.doesNotMatch(bad, /<a[\s>]/);
  assert.match(bad, /\[x\]\(javascript:alert\(1\)\)/);   // kept as inert literal text
});

test("safeMarkdown builds headings and list items", () => {
  assert.match(frag2html(AN.safeMarkdown("## Title")), /<h3>Title<\/h3>/);
  assert.match(frag2html(AN.safeMarkdown("- one\n- two")), /<li>one<\/li>\s*<li>two<\/li>/);
});

function frag2text(frag) {
  const d = document.createElement("div"); d.appendChild(frag); return d.textContent;
}

test("safeMarkdown renders a fenced code block as <pre><code>, not paragraphs", () => {
  const html = frag2html(AN.safeMarkdown("```python\ntokens = []\n```"));
  assert.match(html, /<pre[^>]*><code>/);
  assert.match(html, /<\/code><\/pre>/);
  assert.doesNotMatch(html, /<p>tokens/);       // never line-by-line paragraphs
  assert.match(html, /data-gx-copy/);           // copy affordance
  assert.match(html, /data-gx-expand/);         // expand affordance
  assert.match(frag2text(AN.safeMarkdown("```python\ntokens = []\n```")), /tokens = \[\]/);
});

test("safeMarkdown keeps inline marks inert inside a code block", () => {
  const md = "```\na = **b** and `c`\n```";
  const html = frag2html(AN.safeMarkdown(md));
  assert.doesNotMatch(html, /<strong>/);
  assert.doesNotMatch(html, /<em>/);
  assert.doesNotMatch(html, /<code>c<\/code>/);
  assert.match(frag2text(AN.safeMarkdown(md)), /a = \*\*b\*\* and `c`/);
});

test("safeMarkdown tags the language and tolerates an unterminated fence", () => {
  const html = frag2html(AN.safeMarkdown("```js\nconst x=1"));   // no closing ```
  assert.match(html, /<span>js<\/span>/);
  assert.match(html, /<pre[^>]*><code>/);
  assert.match(frag2text(AN.safeMarkdown("```js\nconst x=1")), /const x=1/);
});

test("shouldSend: plain Enter sends; Shift+Enter newlines", () => {
  assert.strictEqual(AN.shouldSend({ key: "Enter" }), true);
  assert.strictEqual(AN.shouldSend({ key: "Enter", shiftKey: true }), false);
});

test("shouldSend: Cmd/Ctrl+Enter always send", () => {
  assert.strictEqual(AN.shouldSend({ key: "Enter", metaKey: true }), true);
  assert.strictEqual(AN.shouldSend({ key: "Enter", ctrlKey: true }), true);
});

test("shouldSend: IME-composition Enter never sends (CJK candidate selection)", () => {
  assert.strictEqual(AN.shouldSend({ key: "Enter", isComposing: true }), false);
  assert.strictEqual(AN.shouldSend({ key: "Enter", keyCode: 229 }), false);
});

test("shouldSend: non-Enter keys and bad input don't send", () => {
  assert.strictEqual(AN.shouldSend({ key: "a" }), false);
  assert.strictEqual(AN.shouldSend(null), false);
  assert.strictEqual(AN.shouldSend({}), false);
});

test("node replay supports object-property IDs and clears removed conversations", () => {
  const fs = require("node:fs"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../canvas/glimpse-annotate.js"), "utf8");
  const start = source.indexOf("var previousNodeIds = [];");
  const end = source.indexOf("    var agentByReply = {};", start);
  const received = new Map();
  const sandbox = { window: { __GLIMPSE_EXPLAIN__: { mountNodeReply: (id, turns) => received.set(id, turns) } } };
  vm.runInNewContext(source.slice(start, end) + "}\nthis.ingest = ingestThread;", sandbox);
  for (const id of ["constructor", "__proto__", "toString"]) {
    sandbox.ingest([{ id: "q", role: "user", anchor: { kind: "node", id } }, { role: "agent", replyTo: "q", text: "Answer" }]);
    assert.equal(received.get(id).length, 2);
  }
  sandbox.ingest([]);
  assert.equal(received.get("toString").length, 0);
});

// Drive the real conversation state (newComment / quickAsk / sendTurn /
// ingestThread) out of glimpse-annotate.js with the DOM-facing calls stubbed.
function loadConversations() {
  const fs = require("node:fs"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../canvas/glimpse-annotate.js"), "utf8");
  const slice = (from, to) => {
    const s = source.indexOf(from), e = source.indexOf(to, s);
    assert.ok(s >= 0 && e > s, "slice not found: " + from);
    return source.slice(s, e);
  };
  let seq = 0;
  const sandbox = { window: {}, CHANNEL: "ch", hueFor: () => "#000", renderAll: () => {},
                    post: () => {}, armAck: () => {}, uuid: () => "cid-" + (++seq) };
  vm.runInNewContext([
    slice("  var comments = [];", "  // A textarea bound"),
    slice("  function sendTurn(", "  function resendTurn("),
    slice("  function quickAsk(", "  /* ="),
    slice("  var previousNodeIds = [];", "  // Light re-render"),
    "this.api = { comments: comments, quickAsk: quickAsk, sendTurn: sendTurn, ingest: ingestThread };",
  ].join("\n"), sandbox);
  return sandbox.api;
}
// What the store persists for a turn the client sent (anchor is null when the
// selection could not be anchored, e.g. a triple-click ending on an element).
const persisted = (n, turn, quote) =>
  ({ id: "u" + n, role: "user", anchor: null, quote: quote, text: turn.text, clientTurnId: turn.cid });
const reply = (n, to) => ({ id: "a" + n, role: "agent", replyTo: to, text: "answer " + n });

test("unanchored conversation keeps earlier turns when a follow-up is sent", () => {
  const api = loadConversations(), quote = "ECR octo-tools/sia-mcp";
  api.quickAsk(null, quote, "first?");
  const c = api.comments[0];
  const thread = [persisted(1, c.turns[0], quote), reply(1, "u1")];
  api.ingest(thread);
  api.sendTurn(c, "second?");
  thread.push(persisted(2, c.turns[2], quote));
  api.ingest(thread);
  thread.push(reply(2, "u2"));
  api.ingest(thread);
  assert.equal(api.comments.length, 1);
  assert.deepEqual(api.comments[0].turns.map((t) => t.text), ["first?", "answer 1", "second?", "answer 2"]);
});

test("unanchored conversation reloads as one bubble and a re-ask reuses it", () => {
  const api = loadConversations(), quote = "Pods + ExternalSecrets";
  api.ingest([
    { id: "u1", role: "user", anchor: null, quote: quote, text: "q1" }, reply(1, "u1"),
    { id: "u2", role: "user", anchor: null, quote: "other passage", text: "q2" }, reply(2, "u2"),
    { id: "u3", role: "user", anchor: null, quote: quote, text: "q3" }, reply(3, "u3"),
  ]);
  assert.equal(api.comments.length, 2);
  assert.deepEqual(api.comments[0].turns.map((t) => t.text), ["q1", "answer 1", "q3", "answer 3"]);
  api.quickAsk(null, quote, "q4");
  assert.equal(api.comments.length, 2);
  assert.equal(api.comments[0].turns.at(-1).text, "q4");
});
