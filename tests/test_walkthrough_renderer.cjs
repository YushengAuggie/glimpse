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

test("connectors avoid intervening branch and stage cards", () => {
  const col = 380,
    gap = 30;
  const positions = new Map([
    ["gate", { x: 16, y: 104, w: 348, h: 128, stage: 0 }],
    ["side1", { x: 32, y: 280, w: 332, h: 76, stage: 0 }],
    ["side2", { x: 32, y: 404, w: 332, h: 76, stage: 0 }],
    ["next", { x: 16, y: 528, w: 348, h: 76, stage: 0 }],
    ["second", { x: 426, y: 104, w: 348, h: 76, stage: 1 }],
    ["secondEnd", { x: 426, y: 228, w: 348, h: 76, stage: 1 }],
    ["third", { x: 836, y: 104, w: 348, h: 76, stage: 2 }],
  ]);
  const edges = [
    { from: "gate", to: "next", kind: "data" },
    { from: "gate", to: "side1", kind: "side" },
    { from: "gate", to: "side2", kind: "side" },
    { from: "next", to: "gate", kind: "return" },
    { from: "next", to: "gate", kind: "data" },
    { from: "next", to: "second", kind: "data" },
    { from: "secondEnd", to: "gate", kind: "return" },
    { from: "next", to: "third", kind: "call" },
    { from: "third", to: "gate", kind: "return" },
    { from: "second", to: "secondEnd", kind: "data" },
  ];
  for (const edge of edges) {
    const { points } = api.routeEdge(edge, positions, col, gap);
    for (let i = 1; i < points.length; i++) {
      const [x1, y1] = points[i - 1],
        [x2, y2] = points[i];
      assert.ok(x1 === x2 || y1 === y2, "orthogonal path");
      for (const [id, r] of positions) {
        const crosses =
          x1 === x2
            ? x1 > r.x &&
              x1 < r.x + r.w &&
              Math.max(y1, y2) > r.y &&
              Math.min(y1, y2) < r.y + r.h
            : y1 > r.y &&
              y1 < r.y + r.h &&
              Math.max(x1, x2) > r.x &&
              Math.min(x1, x2) < r.x + r.w;
        assert.equal(crosses, false, `${edge.from} → ${edge.to} crosses ${id}`);
      }
    }
  }
});

test("outgoing cross-stage labels and converging return labels stay distinct", () => {
  const positions = new Map([
    ["left", { x: 16, y: 104, w: 348, h: 76, stage: 0 }],
    ["center", { x: 426, y: 104, w: 348, h: 76, stage: 1 }],
    ["right", { x: 836, y: 104, w: 348, h: 76, stage: 2 }],
    ["later", { x: 426, y: 228, w: 348, h: 76, stage: 1 }],
    ["last", { x: 426, y: 352, w: 348, h: 76, stage: 1 }],
  ]);
  const label = (from, to, kind) => {
    const { tx, ty } = api.routeEdge({ from, to, kind }, positions, 380, 30);
    return [tx, ty];
  };
  assert.notDeepEqual(
    label("left", "center", "call"),
    label("left", "right", "call"),
  );
  assert.notDeepEqual(
    label("center", "left", "return"),
    label("center", "right", "call"),
  );
  assert.notDeepEqual(
    label("center", "later", "data"),
    label("center", "last", "call"),
  );
  assert.notDeepEqual(
    label("later", "center", "return"),
    label("later", "last", "data"),
  );
  assert.notDeepEqual(
    label("later", "center", "return"),
    label("last", "center", "return"),
  );
});
