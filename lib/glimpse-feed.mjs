#!/usr/bin/env node
// glimpse-feed.mjs — the locked read-modify-write ops on feed.json, invoked as a
// CLI by `bin/glimpse`. Node stdlib only. Ported from the former glimpse_feed.py
// (behavior-preserving; feed.json stays the same shape).
//
// Subcommands (argv[2]):
//   upsert   env: GLIMPSE_DIR SLUG TITLE TS PENDING(0|1) NOANNOTATE(0|1) KIND
//            upsert one artifact into feed.json.
//   op       env: GLIMPSE_DIR ACTION(remove|removeall|keep|pin|unpin) [SLUGS KEEP SLUG]
//            mutate feed.json; prints removed slugs (one per line) for remove/removeall/keep.
//   list     env: GLIMPSE_DIR [LIST_JSON]
//            list artifacts (pinned first).

import path from "node:path";
import { withLock, readJson, writeJsonAtomic } from "./glimpse-store.mjs";

const env = process.env;

function feedPath() {
  return path.join(env.GLIMPSE_DIR, "feed.json");
}

// Upsert one artifact into feed.json under an exclusive lock (serializes the
// read-modify-write so concurrent publishes can't drop each other's entry).
function cmdUpsert() {
  const slug = env.SLUG;
  const title = env.TITLE;
  const ts = parseInt(env.TS, 10);
  const pending = env.PENDING === "1";
  const noann = env.NOANNOTATE === "1";
  const kind = env.KIND || "";
  const fp = feedPath();
  withLock(fp + ".lock", () => {
    const feed = readJson(fp, { artifacts: [] });
    const list = feed.artifacts || [];
    const old = list.find((a) => a.slug === slug) || {};
    const arts = list.filter((a) => a.slug !== slug);
    const e = { slug, title, ts };
    if (pending) e.pending = true;
    if (noann) e.noannotate = true; // shell skips highlight-chat injection
    if (kind) e.kind = kind; // "explain" → shell inlines glimpse-explain.js
    if (old.pinned) e.pinned = true; // preserve a pin across re-publish
    arts.push(e);
    writeJsonAtomic(fp, { artifacts: arts });
  });
}

// Mutate feed.json under an exclusive lock. ACTION ∈ remove|removeall|keep|pin|unpin.
// For remove/removeall/keep it prints the removed slugs (one per line) so the
// caller can delete the matching artifact files.
function cmdOp() {
  const action = env.ACTION;
  const fp = feedPath();
  withLock(fp + ".lock", () => {
    let arts = (readJson(fp, { artifacts: [] }).artifacts) || [];
    let removed = [];
    if (action === "remove") {
      const s = new Set((env.SLUGS || "").split(/\s+/).filter(Boolean));
      removed = arts.filter((a) => s.has(a.slug)).map((a) => a.slug);
      arts = arts.filter((a) => !s.has(a.slug));
    } else if (action === "removeall") {
      removed = arts.map((a) => a.slug);
      arts = [];
    } else if (action === "keep") {
      const n = parseInt(env.KEEP, 10);
      // break ties on insertion order so equal-ts artifacts keep the NEWEST n
      const order = arts
        .map((a, i) => [i, a])
        .sort((x, y) => (y[1].ts || 0) - (x[1].ts || 0) || y[0] - x[0])
        .map((p) => p[1]);
      const keep = order
        .filter((a) => a.pinned)
        .concat(order.filter((a) => !a.pinned).slice(0, n));
      const ks = new Set(keep.map((a) => a.slug));
      removed = arts.filter((a) => !ks.has(a.slug)).map((a) => a.slug);
      arts = arts.filter((a) => ks.has(a.slug));
    } else if (action === "pin" || action === "unpin") {
      const sl = env.SLUG;
      for (const a of arts) {
        if (a.slug === sl) {
          if (action === "pin") a.pinned = true;
          else delete a.pinned;
        }
      }
    }
    writeJsonAtomic(fp, { artifacts: arts });
    for (const r of removed) process.stdout.write(r + "\n");
  });
}

function cmdList() {
  let arts = (readJson(feedPath(), { artifacts: [] }).artifacts) || [];
  arts = arts
    .slice()
    .sort(
      (a, b) =>
        (a.pinned ? 0 : 1) - (b.pinned ? 0 : 1) || (b.ts || 0) - (a.ts || 0),
    );
  // Machine-readable escape hatch for agents (mirrors `glimpse poll --json`): one
  // compact JSON object, valid whether or not there are artifacts.
  if (env.LIST_JSON === "1") {
    process.stdout.write(JSON.stringify({ artifacts: arts }) + "\n");
    return;
  }
  if (!arts.length) {
    process.stdout.write("(no artifacts)\n");
    return;
  }
  const now = Date.now() / 1000;
  for (const a of arts) {
    const age = now - (a.ts || now);
    const d =
      age < 3600
        ? `${Math.floor(age / 60)}m`
        : age < 86400
          ? `${Math.floor(age / 3600)}h`
          : `${Math.floor(age / 86400)}d`;
    const mark = a.pinned ? "*" : " ";
    const pend = a.pending ? " [awaiting]" : "";
    process.stdout.write(
      `${mark} ${(a.slug || "").padEnd(26)} ${d.padStart(4)}  ${(a.title || "").slice(0, 48)}${pend}\n`,
    );
  }
}

const DISPATCH = { upsert: cmdUpsert, op: cmdOp, list: cmdList };
const sub = process.argv[2] || "";
const fn = DISPATCH[sub];
if (!fn) {
  process.stderr.write(`glimpse-feed.mjs: unknown subcommand ${JSON.stringify(sub)}\n`);
  process.exit(2);
}
fn();
