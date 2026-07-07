// Multi-artifact isolation for the per-document thread store (roadmap item K).
//
// Glimpse keys every feedback/highlight stream per artifact by slug: threads live
// in threads/<slug>.json, one exclusive-locked read-modify-write each. These tests
// pin that two concurrently-active artifacts never bleed into each other's thread,
// pending queue, or reply routing — and that clearing/one-shot ops on A leave B
// untouched — so several published artifacts (and the agents addressing them) stay
// independent.
//
// Driven through glimpse-threads.mjs exactly as bin/glimpse invokes it (env-passed
// args, subprocess), so the test exercises the real CLI contract the bridge/agent
// rely on. Ported from tests/test_glimpse_threads_multi.py.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THREADS = path.join(__dirname, "..", "lib", "glimpse-threads.mjs");

function newRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glimpse-"));
  return path.join(tmp, "glimpse");
}

function _op(root, action, env = {}) {
  const e = { ...process.env, GLIMPSE_DIR: String(root), ACTION: action };
  for (const [k, v] of Object.entries(env)) {
    e[k] = v === null || v === undefined ? "" : String(v);
  }
  const r = spawnSync("node", [THREADS, "op"], { env: e, encoding: "utf8" });
  assert.equal(r.status, 0, `op ${action} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function _run(root, sub) {
  const r = spawnSync("node", [THREADS, sub], {
    env: { ...process.env, GLIMPSE_DIR: String(root) },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `${sub} failed: ${r.stderr}`);
  return r.stdout;
}

function _pending(root) {
  return _run(root, "pending")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function _add_user(root, slug, text, quote = "", cid = null) {
  return _op(root, "add_user", {
    SLUG: slug,
    TEXT: text,
    QUOTE: quote,
    CLIENT_TURN_ID: cid,
  });
}

test("two artifacts keep separate threads", () => {
  const root = newRoot();
  const a = _add_user(root, "alpha", "what is A?", "q on A", "cA1");
  const b = _add_user(root, "beta", "what is B?", "q on B", "cB1");
  assert.ok(a && b && a !== b);

  // Each thread holds only its own turn — no cross-artifact bleed.
  const ta = JSON.parse(_op(root, "print_json", { SLUG: "alpha" }));
  const tb = JSON.parse(_op(root, "print_json", { SLUG: "beta" }));
  assert.equal(ta.slug, "alpha");
  assert.deepEqual(
    ta.turns.map((t) => t.text),
    ["what is A?"],
  );
  assert.equal(tb.slug, "beta");
  assert.deepEqual(
    tb.turns.map((t) => t.text),
    ["what is B?"],
  );

  // pending lists both, each tagged with its own slug.
  const pend = _pending(root);
  assert.deepEqual(new Set(pend.map((p) => p.slug)), new Set(["alpha", "beta"]));
  const idToSlug = {};
  for (const p of pend) idToSlug[p.id] = p.slug;
  assert.deepEqual(idToSlug, { [a]: "alpha", [b]: "beta" });
});

test("reply addresses only its artifact", () => {
  const root = newRoot();
  const a = _add_user(root, "alpha", "q A", "", "cA1");
  _add_user(root, "beta", "q B", "", "cB1");

  // Answer alpha's turn; beta must remain pending and unanswered.
  _op(root, "add_agent", { SLUG: "alpha", TEXT: "A answered", TO: a });
  const pend = _pending(root);
  assert.deepEqual(
    pend.map((p) => p.slug),
    ["beta"],
    "only beta should still be pending",
  );

  const ta = JSON.parse(_op(root, "print_json", { SLUG: "alpha" }));
  assert.deepEqual(
    ta.turns.filter((t) => t.role === "user").map((t) => t.status),
    ["answered"],
  );
  const tb = JSON.parse(_op(root, "print_json", { SLUG: "beta" }));
  assert.deepEqual(
    tb.turns.filter((t) => t.role === "user").map((t) => t.status),
    ["pending"],
  );
  // alpha's agent reply is anchored to alpha's turn, never beta's.
  assert.deepEqual(
    ta.turns.filter((t) => t.role === "agent").map((t) => t.replyTo),
    [a],
  );
});

test("reply to foreign turn id is rejected", () => {
  // A turn id from artifact A cannot be answered inside artifact B's thread.
  const root = newRoot();
  const a = _add_user(root, "alpha", "q A", "", "cA1");
  _add_user(root, "beta", "q B", "", "cB1");
  const r = spawnSync("node", [THREADS, "op"], {
    env: {
      ...process.env,
      GLIMPSE_DIR: String(root),
      ACTION: "add_agent",
      SLUG: "beta",
      TEXT: "wrong",
      TO: a,
    },
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0, "answering alpha's turn under beta must fail");
  assert.ok(r.stderr.includes("no user turn"));
});

test("clear one artifact leaves the other", () => {
  const root = newRoot();
  _add_user(root, "alpha", "q A", "", "cA1");
  _add_user(root, "beta", "q B", "", "cB1");
  _op(root, "clear", { SLUG: "alpha" });

  // alpha's thread is gone; beta's is intact and still pending.
  const tdir = path.join(root, "threads");
  assert.ok(!fs.existsSync(path.join(tdir, "alpha.json")));
  assert.ok(fs.existsSync(path.join(tdir, "beta.json")));
  assert.deepEqual(
    _pending(root).map((p) => p.slug),
    ["beta"],
  );
});

test("same client turn id across artifacts does not collide", () => {
  // clientTurnId dedup is scoped to one thread — the same id on two slugs is two turns.
  const root = newRoot();
  const a = _add_user(root, "alpha", "q A", "", "dup");
  const b = _add_user(root, "beta", "q B", "", "dup");
  assert.notEqual(
    a,
    b,
    "identical clientTurnId on different slugs must be distinct turns",
  );
  // Re-delivering the SAME slug+cid is idempotent (returns the existing turn).
  assert.equal(_add_user(root, "alpha", "q A again", "", "dup"), a);
});
