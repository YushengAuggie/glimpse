import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, repo } from "./walkthrough-fixture.mjs";
import { buildSnapshot } from "../lib/glimpse-walkthrough.mjs";
import {
  bind,
  evidence,
  connect,
  disconnect,
} from "../lib/glimpse-walkthrough-context.mjs";
import { sanitizePath } from "../lib/glimpse-server.mjs";

function setup(t) {
  const root = repo(t),
    dir = path.join(root, "state");
  const snapshot = buildSnapshot(fixture(), root);
  bind(dir, "tour", snapshot, root);
  const anchor = {
    kind: "node",
    id: "end",
    frame: "child",
    block: "child_b0",
    revision: snapshot.revision,
    file: "main.js",
    lines: "6-7",
  };
  const op = (action, extra = {}) =>
    spawnSync(process.execPath, ["lib/glimpse-threads.mjs", "op"], {
      encoding: "utf8",
      env: {
        ...process.env,
        GLIMPSE_DIR: dir,
        SLUG: "tour",
        ACTION: action,
        ...extra,
      },
    });
  const read = () =>
    JSON.parse(fs.readFileSync(path.join(dir, "threads/tour.json")));
  return { root, dir, snapshot, anchor, op, read };
}
test("thread persistence retains and validates stable walkthrough targets", (t) => {
  const { anchor, op, read } = setup(t);
  const added = op("add_user", {
    ANCHOR: JSON.stringify(anchor),
    TEXT: "Why?",
    CLIENT_TURN_ID: "client-1",
  });
  assert.equal(added.status, 0, added.stderr);
  assert.equal(read().turns[0].anchor.frame, "child");
  assert.equal(read().turns[0].anchor.block, "child_b0");
  assert.equal(read().turns[0].anchor.revision, anchor.revision);
  const invalid = op("add_user", {
    ANCHOR: JSON.stringify({ ...anchor, block: "entry_b0" }),
    TEXT: "Why?",
    CLIENT_TURN_ID: "client-2",
  });
  assert.notEqual(invalid.status, 0);
  assert.equal(read().turns.length, 1);
});
test("walkthrough answers need checked evidence and keep reply identity", (t) => {
  const { dir, anchor, op, read } = setup(t);
  const added = op("add_user", {
    ANCHOR: JSON.stringify(anchor),
    TEXT: "Why?",
    CLIENT_TURN_ID: "client-1",
  });
  assert.equal(added.status, 0, added.stderr);
  const id = added.stdout.trim();
  assert.notEqual(
    op("add_agent", { TO: id, TEXT: "Ungrounded answer" }).status,
    0,
  );
  const answer = {
    claims: [
      {
        kind: "source",
        text: "The child adds one.",
        evidence: [evidence(dir, "tour", "main.js", 6, 7)],
      },
    ],
  };
  const session = connect(dir, "tour").session;
  const reply = op("add_agent", {
    TO: id,
    ANSWER_JSON: JSON.stringify(answer),
    WALKTHROUGH_SESSION: session,
  });
  assert.equal(reply.status, 0, reply.stderr);
  assert.equal(read().turns[0].status, "answered");
  assert.equal(read().turns[1].replyTo, id);
  assert.equal(
    read().turns[1].answer.claims[0].evidence[0].raw,
    "function child(value) {\n  const output = value + 1;",
  );
  assert.equal(
    op("add_agent", {
      TO: id,
      ANSWER_JSON: JSON.stringify(answer),
      WALKTHROUGH_SESSION: session,
    }).stdout.trim(),
    reply.stdout.trim(),
  );
  assert.equal(read().turns.length, 2);
});
test("static resolution blocks private bindings including a symlink alias", (t) => {
  const { dir } = setup(t);
  assert.equal(sanitizePath(dir, "/.walkthrough/tour/binding.json"), null);
  assert.equal(sanitizePath(dir, "/%2ewalkthrough/tour/session.json"), null);
  fs.symlinkSync(path.join(dir, ".walkthrough"), path.join(dir, "alias"));
  assert.equal(sanitizePath(dir, "/alias/tour/binding.json"), null);
  assert.equal(
    sanitizePath(dir, "/threads/tour.json"),
    path.join(dir, "threads/tour.json"),
  );
});
test("clearing a bound thread cannot disable target or answer checks", (t) => {
  const { anchor, op, read } = setup(t);
  assert.equal(op("clear").status, 0);
  assert.notEqual(op("add_user", { TEXT: "Missing target" }).status, 0);
  assert.equal(
    op("add_user", { ANCHOR: JSON.stringify(anchor), TEXT: "Valid target" })
      .status,
    0,
  );
  const id = read().turns[0].id;
  assert.notEqual(op("add_agent", { TO: id, TEXT: "Unchecked" }).status, 0);
});
test("expired or disconnected answerers cannot persist new replies", (t) => {
  const { dir, anchor, op } = setup(t);
  const owner = connect(dir, "tour");
  const added = op("add_user", {
    ANCHOR: JSON.stringify(anchor),
    TEXT: "Why?",
  });
  const answer = JSON.stringify({
    claims: [{ kind: "unknown", text: "Needs more evidence" }],
  });
  disconnect(dir, "tour", owner.session);
  assert.notEqual(
    op("add_agent", {
      TO: added.stdout.trim(),
      ANSWER_JSON: answer,
      WALKTHROUGH_SESSION: owner.session,
    }).status,
    0,
  );
  const next = connect(dir, "tour");
  assert.notEqual(
    op("add_agent", {
      TO: added.stdout.trim(),
      ANSWER_JSON: answer,
      WALKTHROUGH_SESSION: owner.session,
    }).status,
    0,
  );
  assert.equal(
    op("add_agent", {
      TO: added.stdout.trim(),
      ANSWER_JSON: answer,
      WALKTHROUGH_SESSION: next.session,
    }).status,
    0,
  );
});
test("private context denial is case insensitive, including symlink aliases", (t) => {
  const { dir } = setup(t);
  assert.equal(sanitizePath(dir, "/.WALKTHROUGH/tour/binding.json"), null);
  fs.symlinkSync(path.join(dir, ".walkthrough"), path.join(dir, "alias"));
  if (fs.existsSync(path.join(dir, "ALIAS/tour/BINDING.JSON")))
    assert.equal(sanitizePath(dir, "/ALIAS/tour/BINDING.JSON"), null);
});
