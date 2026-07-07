#!/usr/bin/env node
// glimpse-threads.mjs — the per-document conversation store: threads/<slug>.json,
// one exclusive-locked, atomic read-modify-write so a flocked agent `reply` and the
// bridge's pending-question write can never corrupt each other, and the static
// server never serves a half-written file. Invoked as a CLI by `bin/glimpse`.
// Node stdlib only. Ported from the former glimpse_threads.py (behavior-preserving).
//
// Subcommands (argv[2]):
//   op       env: GLIMPSE_DIR SLUG ACTION plus per-action fields. ACTION ∈
//              add_user   SLUG ANCHOR(json) QUOTE TEXT CLIENT_TURN_ID ARTIFACT_TS TS → prints the turn id
//              add_agent  SLUG TEXT TO TS                                           → prints the turn id, flips TO→answered
//              clear      SLUG
//              print      SLUG            (readable transcript)
//              print_json SLUG            (raw file)
//            Turn text/quote are capped and secret-scrubbed; files are chmod 0600.
//   list     env: GLIMPSE_DIR — list conversation threads.
//   pending  env: GLIMPSE_DIR — print pending user turns as JSON lines
//              ({type,id,slug,ts,quote,text,anchor}); consumed by the bridge + `glimpse poll`.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { withLock, writeJsonAtomic } from "./glimpse-store.mjs";

const env = process.env;

// A spec-content / precondition failure: like Python's SystemExit("msg"), it must
// print `msg` to stderr and exit non-zero — but thrown so withLock's release runs
// first (process.exit would skip the finally and leak the lock file).
class Abort extends Error {}

function threadsDir() {
  return path.join(env.GLIMPSE_DIR, "threads");
}

function cmdOp() {
  const action = env.ACTION;
  const slug = env.SLUG;
  const tdir = threadsDir();
  fs.mkdirSync(tdir, { recursive: true });
  const fp = path.join(tdir, slug + ".json");
  const TURN_CAP = parseInt(env.GLIMPSE_TURN_CAP || "2000", 10);
  const TEXT_CAP = parseInt(env.GLIMPSE_TEXT_CAP || String(64 * 1024), 10);
  const SECRET = env.SECRET_PATTERN || "";
  let secretRe = null;
  if (SECRET) {
    try {
      secretRe = new RegExp("(" + SECRET + ")", "g");
    } catch {
      secretRe = null;
    }
  }
  const scrub = (s) => {
    s = s || "";
    if (secretRe !== null) s = s.replace(secretRe, "[REDACTED]");
    return s.slice(0, TEXT_CAP);
  };
  const now = () => parseInt(env.TS, 10) || Math.floor(Date.now() / 1000);
  const rid = () => crypto.randomBytes(2).toString("hex");

  withLock(fp + ".lock", () => {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch {
      data = { version: 1, slug, artifactTs: null, turns: [] };
    }
    if (!Array.isArray(data.turns)) data.turns = [];
    const turns = data.turns;
    let dirty = false;
    let out = null;

    if (action === "add_user") {
      const cid = env.CLIENT_TURN_ID || "";
      const ex = turns.find((t) => cid && t.clientTurnId === cid);
      if (ex) {
        out = ex.id; // idempotent: same question delivered twice
      } else {
        if (turns.length >= TURN_CAP)
          throw new Abort(
            `glimpse: thread '${slug}' is full (${TURN_CAP} turns)`,
          );
        const ts = now();
        const tid = `${ts}-${turns.length + 1}-${rid()}`; // suffix avoids post-clear id reuse
        let anchor = null;
        if (env.ANCHOR) {
          try {
            anchor = JSON.parse(env.ANCHOR);
          } catch {
            anchor = null;
          }
        }
        if (anchor && typeof anchor === "object" && !Array.isArray(anchor)) {
          if (anchor.kind === "node") {
            // node anchor: scrub agent text fields; no occurrence (keyed by id).
            for (const k of ["label", "file", "lines"]) {
              if (typeof anchor[k] === "string") anchor[k] = scrub(anchor[k]);
              else if (k in anchor) delete anchor[k];
            }
            if (typeof anchor.id !== "string") {
              anchor = null;
            } else {
              anchor = {
                kind: "node",
                id: anchor.id,
                label: anchor.label || "",
                file: anchor.file || "",
                lines: anchor.lines || "",
              };
            }
          } else {
            // The anchor carries the *selected text* (exact/prefix/suffix); scrub +
            // cap it like quote/text — it would otherwise smuggle secrets past the guard.
            for (const k of ["exact", "prefix", "suffix"]) {
              if (typeof anchor[k] === "string") anchor[k] = scrub(anchor[k]);
              else if (k in anchor) delete anchor[k];
            }
            const occ = parseInt(anchor.occurrence, 10);
            anchor.occurrence = Number.isNaN(occ) ? 0 : occ;
          }
        } else {
          anchor = null;
        }
        if (env.ARTIFACT_TS) {
          const at = parseInt(env.ARTIFACT_TS, 10);
          if (!Number.isNaN(at)) data.artifactTs = at;
        }
        const t = {
          id: tid,
          role: "user",
          status: "pending",
          anchor,
          quote: scrub(env.QUOTE || ""),
          text: scrub(env.TEXT || ""),
          ts,
        };
        if (cid) t.clientTurnId = cid;
        turns.push(t);
        out = tid;
        dirty = true;
      }
    } else if (action === "add_agent") {
      const to = env.TO;
      const u = turns.find((t) => t.id === to && t.role === "user");
      if (u === undefined)
        throw new Abort(`glimpse: no user turn '${to}' in thread '${slug}'`);
      const ex = turns.find((t) => t.role === "agent" && t.replyTo === to);
      if (ex) {
        out = ex.id; // idempotent: one answer per question (re-delivery is a no-op)
      } else {
        if (turns.length >= TURN_CAP)
          throw new Abort(
            `glimpse: thread '${slug}' is full (${TURN_CAP} turns)`,
          );
        const ts = now();
        const tid = `${ts}-${turns.length + 1}-${rid()}`;
        turns.push({
          id: tid,
          role: "agent",
          replyTo: to,
          text: scrub(env.TEXT || ""),
          ts,
        });
        u.status = "answered";
        out = tid;
        dirty = true;
      }
    } else if (action === "clear") {
      if (!fs.existsSync(fp)) throw new Abort(`glimpse: no thread '${slug}'`);
      fs.rmSync(fp); // delete outright so it leaves the `threads` listing too
    } else if (action === "print_json") {
      if (!fs.existsSync(fp)) throw new Abort(`glimpse: no thread '${slug}'`);
      process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    } else if (action === "print") {
      if (!fs.existsSync(fp)) throw new Abort(`glimpse: no thread '${slug}'`);
      const n = turns.length;
      process.stdout.write(
        `# thread: ${slug}   (${n} turn${n === 1 ? "" : "s"})\n`,
      );
      for (const t of turns) {
        if (t.role === "user") {
          let q = (t.quote || "").replace(/\n/g, " ").trim();
          if (q.length > 80) q = q.slice(0, 79) + "…";
          process.stdout.write(`\n[user ${t.id} · ${t.status || ""}]\n`);
          if (q) process.stdout.write(`  ❝${q}❞\n`);
          process.stdout.write(`  Q: ${(t.text || "").trim()}\n`);
        } else {
          process.stdout.write(`[agent → ${t.replyTo || ""}]\n`);
          process.stdout.write(`  ${(t.text || "").trim()}\n`);
        }
      }
    }

    if (dirty) writeJsonAtomic(fp, data, { mode: 0o600 });
    if (out !== null) process.stdout.write(out + "\n");
  });
}

function listJsonFiles(tdir) {
  try {
    return fs.readdirSync(tdir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

function cmdList() {
  const tdir = threadsDir();
  const files = listJsonFiles(tdir);
  if (!files.length) {
    process.stdout.write("(no threads)\n");
    return;
  }
  for (const f of files) {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(tdir, f), "utf8"));
    } catch {
      continue;
    }
    const turns = d.turns || [];
    const n = turns.length;
    const pend = turns.filter(
      (t) => t.role === "user" && t.status === "pending",
    ).length;
    const pendStr = pend ? `  (${pend} pending)` : "";
    process.stdout.write(
      `${f.slice(0, -5).padEnd(28)} ${String(n).padStart(3)} turn${n === 1 ? "" : "s"}${pendStr}\n`,
    );
  }
}

function cmdPending() {
  const tdir = threadsDir();
  for (const f of listJsonFiles(tdir)) {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(tdir, f), "utf8"));
    } catch {
      continue;
    }
    const slug = d.slug || f.slice(0, -5);
    for (const t of d.turns || []) {
      if (t.role === "user" && t.status === "pending") {
        process.stdout.write(
          JSON.stringify({
            type: "question",
            id: t.id,
            slug,
            ts: t.ts,
            quote: t.quote || "",
            text: t.text || "",
            anchor: t.anchor ?? null,
          }) + "\n",
        );
      }
    }
  }
}

const DISPATCH = { op: cmdOp, list: cmdList, pending: cmdPending };
const sub = process.argv[2] || "";
const fn = DISPATCH[sub];
if (!fn) {
  process.stderr.write(
    `glimpse-threads.mjs: unknown subcommand ${JSON.stringify(sub)}\n`,
  );
  process.exit(2);
}
try {
  fn();
} catch (e) {
  if (e instanceof Abort) {
    process.stderr.write(e.message + "\n");
    process.exit(1);
  }
  throw e;
}
