import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, repo } from "./walkthrough-fixture.mjs";
import { buildSnapshot } from "../lib/glimpse-walkthrough.mjs";
const context = await import("../lib/glimpse-walkthrough-context.mjs").catch(
  () => ({}),
);
function setup(t) {
  const root = repo(t),
    dir = path.join(root, "data");
  const snapshot = buildSnapshot(fixture(), root);
  assert.equal(
    typeof context.bind,
    "function",
    "local context binding is required",
  );
  context.bind(dir, "tour", snapshot, root);
  return { root, dir, snapshot };
}
test("binds locally without putting private repository/session fields in thread state", (t) => {
  const { root, dir } = setup(t);
  const connection = context.connect(dir, "tour", 1000);
  assert.ok(connection.session);
  context.heartbeat(dir, "tour", connection.session, 2000);
  const thread = JSON.parse(
    fs.readFileSync(path.join(dir, "threads/tour.json")),
  );
  assert.equal(thread.walkthrough.state, "connected");
  assert.ok(thread.walkthrough.expiresAt > 2000);
  assert.ok(!JSON.stringify(thread).includes(root));
  assert.ok(!JSON.stringify(thread).includes(connection.session));
  assert.throws(() => context.connect(dir, "tour", 3000), /already|active/i);
});
test("restores delivered but unanswered turns and preserves target IDs after lease expiry", (t) => {
  const { dir, snapshot } = setup(t);
  const threadPath = path.join(dir, "threads/tour.json");
  const thread = JSON.parse(fs.readFileSync(threadPath));
  thread.turns.push({
    id: "q1",
    role: "user",
    text: "Why increment?",
    status: "pending",
    anchor: {
      kind: "node",
      id: "end",
      frame: "child",
      block: "child_b0",
      revision: snapshot.revision,
    },
  });
  fs.writeFileSync(threadPath, JSON.stringify(thread));
  fs.writeFileSync(
    path.join(dir, ".poll.state"),
    JSON.stringify({ delivered: ["q1"] }),
  );
  const first = context.connect(dir, "tour", 1000);
  const resumed = context.connect(dir, "tour", 1000000);
  assert.notEqual(first.session, resumed.session);
  assert.deepEqual(
    resumed.pending.map((q) => q.id),
    ["q1"],
  );
  const resolved = context.resolveContext(dir, "tour", "q1");
  assert.equal(resolved.question.id, "q1");
  assert.equal(resolved.snapshot, undefined);
  assert.equal(resolved.target.frame.blocks[0].raw, undefined);
  assert.equal(resolved.target.block.htmlLines, undefined);
  assert.equal(
    resolved.target.block.raw,
    "function child(value) {\n  const output = value + 1;",
  );
  assert.equal(resolved.caller.block.raw, "  return child(input);\n}");
  assert.throws(
    () => context.heartbeat(dir, "tour", first.session, 1000010),
    /session/i,
  );
});
test("detects current-source drift while preserving original snapshot", (t) => {
  const { root, dir, snapshot } = setup(t);
  fs.appendFileSync(path.join(root, "main.js"), "// new code\n");
  const resolved = context.resolveContext(dir, "tour");
  assert.deepEqual(resolved.changedFiles, ["main.js"]);
  assert.equal(resolved.revision, snapshot.revision);
  assert.equal(resolved.snapshot.frames[0].blocks[1].raw, undefined);
  assert.equal(resolved.snapshot.files["main.js"].raw, undefined);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(dir, ".walkthrough/tour/snapshot.json")),
    ).frames[0].blocks[1].raw,
    "  return child(input);\n}",
  );
});
test("evidence reads related files on demand but blocks escaping paths", (t) => {
  const { root, dir } = setup(t);
  fs.writeFileSync(
    path.join(root, "types.js"),
    'export const resultType = "number";\n',
  );
  const evidence = context.evidence(dir, "tour", "types.js", 1, 1);
  assert.equal(evidence.raw, 'export const resultType = "number";');
  assert.equal(evidence.version, "current");
  assert.throws(
    () => context.evidence(dir, "tour", "../outside", 1, 1),
    /relative|escape/,
  );
});
test("validates answer evidence bytes, rejects stale hashes and unsupported citations", (t) => {
  const { root, dir } = setup(t);
  const evidence = context.evidence(dir, "tour", "main.js", 6, 7);
  const reply = {
    claims: [
      { kind: "source", text: "The child adds one.", evidence: [evidence] },
    ],
  };
  const checked = context.validateAnswer(dir, "tour", reply);
  assert.equal(
    checked.claims[0].evidence[0].raw,
    "function child(value) {\n  const output = value + 1;",
  );
  assert.throws(
    () =>
      context.validateAnswer(dir, "tour", {
        claims: [{ kind: "source", text: "It writes to a DB.", evidence: [] }],
      }),
    /evidence/i,
  );
  fs.appendFileSync(path.join(root, "main.js"), "// changed\n");
  assert.throws(
    () => context.validateAnswer(dir, "tour", reply),
    /changed|stale|hash/i,
  );
  const unknown = context.validateAnswer(dir, "tour", {
    claims: [
      { kind: "unknown", text: "No run record was supplied.", evidence: [] },
    ],
  });
  assert.equal(unknown.claims[0].kind, "unknown");
});
test("rejects a question target that does not belong to the saved snapshot", (t) => {
  const { dir, snapshot } = setup(t),
    fp = path.join(dir, "threads/tour.json");
  const thread = JSON.parse(fs.readFileSync(fp));
  thread.turns.push({
    id: "q1",
    role: "user",
    status: "pending",
    text: "read secrets",
    anchor: {
      kind: "node",
      id: "end",
      frame: "entry",
      block: "child_b0",
      revision: snapshot.revision,
    },
  });
  fs.writeFileSync(fp, JSON.stringify(thread));
  assert.throws(
    () => context.resolveContext(dir, "tour", "q1"),
    /block|target/i,
  );
});
test("does not replace a previously bound artifact or lose its thread", (t) => {
  const { root, dir, snapshot } = setup(t);
  assert.throws(
    () => context.bind(dir, "tour", snapshot, root),
    /exists|new slug/i,
  );
});
test("follow-up context includes prior node answers and excludes unrelated conversations", (t) => {
  const { dir, snapshot } = setup(t);
  const file = path.join(dir, "threads/tour.json");
  const thread = JSON.parse(fs.readFileSync(file));
  const anchor = {
    kind: "node",
    id: "end",
    frame: "child",
    block: "child_b0",
    revision: snapshot.revision,
  };
  thread.turns = [
    {
      id: "q1",
      role: "user",
      anchor,
      text: "First question",
      status: "answered",
    },
    { id: "a1", role: "agent", replyTo: "q1", text: "Previous explanation" },
    {
      id: "else",
      role: "user",
      anchor: { ...anchor, id: "call" },
      text: "Unrelated",
      status: "pending",
    },
    {
      id: "q2",
      role: "user",
      anchor,
      text: "Why did you say that?",
      status: "pending",
    },
  ];
  fs.writeFileSync(file, JSON.stringify(thread));
  const contextResult = context.resolveContext(dir, "tour", "q2");
  assert.deepEqual(
    contextResult.conversation.map((t) => t.id),
    ["q1", "a1", "q2"],
  );
  assert.equal(contextResult.pending, undefined);
});
