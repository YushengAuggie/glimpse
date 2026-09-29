const { test } = require("node:test");
const assert = require("node:assert/strict");
let api = {};
try {
  api = require("../canvas/glimpse-walkthrough.js");
} catch {}
const spec = {
  slug: "tour",
  revision: "abc",
  frames: [
    {
      id: "root",
      file: "a.js",
      calls: { child: 1 },
      blocks: [
        { id: "r0", start: 1, end: 2, raw: "one" },
        { id: "r1", start: 3, end: 4, raw: "child()" },
      ],
    },
    {
      id: "child",
      file: "b.js",
      calls: {},
      blocks: [
        { id: "c0", start: 5, end: 6, raw: "compute" },
        { id: "c1", start: 7, end: 8, raw: "return" },
      ],
    },
  ],
  nodes: [
    { id: "one", frame: "root", label: "Root", blocks: [1] },
    { id: "two", frame: "child", label: "Child", blocks: [0] },
  ],
};
test("starts with diagram alone and derives the inspected caller block", () => {
  assert.equal(
    typeof api.createState,
    "function",
    "walkthrough model required",
  );
  const state = api.createState(spec);
  assert.equal(state.visible, false);
  state.select("two");
  assert.equal(state.visible, true);
  assert.equal(state.frame, "child");
  assert.deepEqual(state.stack(), [
    { frame: "root", block: 1 },
    { frame: "child", block: null },
  ]);
  assert.equal(state.inspect("root"), 1);
  assert.equal(state.selected, "two");
});
test("navigation does not retarget or erase a draft", () => {
  const state = api.createState(spec);
  state.select("two");
  state.openAsk(0);
  state.draft("Why?");
  state.select("one");
  assert.equal(state.ask.node, "two");
  assert.equal(state.ask.frame, "child");
  assert.equal(state.ask.block, "c0");
  assert.equal(state.draft(), "Why?");
  const msg = state.message("channel", "client");
  assert.equal(msg.anchor.frame, "child");
  assert.equal(msg.anchor.revision, "abc");
  assert.equal(msg.text, "Why?");
});
test("ack is receipt only and thread replay deduplicates the pending request", () => {
  const state = api.createState(spec);
  state.select("two");
  state.openAsk(0);
  state.draft("Why?");
  state.message("channel", "client");
  state.ack("other");
  assert.equal(state.pending.get("client").status, "sending");
  state.ack("client");
  assert.equal(state.pending.get("client").status, "received");
  state.replay("two", [
    {
      id: "q1",
      clientTurnId: "client",
      role: "user",
      text: "Why?",
      status: "pending",
    },
  ]);
  assert.equal(state.pending.size, 0);
  assert.equal(state.threads.get("two").length, 1);
  assert.equal(state.draft(), "");
});
test("message trust boundary checks parent and channel; connection expires", () => {
  const parent = {};
  assert.equal(
    api.acceptMessage({ source: {}, data: { channelId: "a" } }, parent, "a"),
    false,
  );
  assert.equal(
    api.acceptMessage(
      { source: parent, data: { channelId: "b" } },
      parent,
      "a",
    ),
    false,
  );
  assert.equal(
    api.acceptMessage(
      { source: parent, data: { channelId: "a" } },
      parent,
      "a",
    ),
    true,
  );
  const status = { state: "connected", expiresAt: 200, revision: "abc" };
  assert.equal(api.connected(null, status, "abc", 100), false); // config can load late
  assert.equal(api.connected({ channelId: "a" }, status, "abc", 100), true);
  assert.equal(api.connected({ channelId: "a" }, status, "abc", 201), false);
  assert.equal(api.connected({ channelId: "a" }, status, "other", 100), false);
});
test("retry reuses the original identity and sending is IME safe", () => {
  const state = api.createState(spec);
  state.select("two");
  state.openAsk(0);
  state.draft("Why?");
  state.message("a", "first");
  assert.equal(state.message("a", "retry").clientTurnId, "first");
  assert.equal(api.shouldSend({ key: "Enter", isComposing: true }), false);
  assert.equal(api.shouldSend({ key: "Enter", shiftKey: true }), false);
  assert.equal(api.shouldSend({ key: "Enter" }), true);
});
