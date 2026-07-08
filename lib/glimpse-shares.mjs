#!/usr/bin/env node
// glimpse-shares.mjs — the locked read-modify-write ops on shares.json, invoked as
// a CLI by `bin/glimpse`. Node stdlib only. Mirrors glimpse-feed.mjs's shape and
// lock discipline so both CLI and canvas share paths persist the same record.
//
// shares.json records every successful `glimpse share`, keyed by slug, so a shared
// link (its URL + secret update_key + password) is RETRIEVABLE later instead of
// being printed once and lost. It holds the update_key and (for private shares) the
// password, so it is written 0o600 and — like threads/ — is NEVER served by the
// static server; the canvas reads it only over the pull-only bridge channel.
//
// Shape: { "shares": { "<slug>": {url, site_id, update_key, visibility, password?, ts} } }
//   visibility ∈ "public" | "private"; password present only for private shares.
//
// Subcommands (argv[2]):
//   record   env: GLIMPSE_DIR SLUG URL SITE_ID UPDATE_KEY VISIBILITY PASSWORD TS
//            upsert one share record.
//   get      env: GLIMPSE_DIR SLUG [SHARES_JSON]
//            print one record as JSON (or nothing if absent); exit 0 found, 1 absent.
//   list     env: GLIMPSE_DIR [SHARES_JSON]
//            list shared artifacts (newest first).

import path from "node:path";
import { withLock, readJson, writeJsonAtomic } from "./glimpse-store.mjs";

const env = process.env;

function sharesPath() {
  return path.join(env.GLIMPSE_DIR, "shares.json");
}

// Read the shares map, tolerating a missing/corrupt file (matches the feed ops).
export function readShares(fp) {
  const data = readJson(fp, { shares: {} });
  return data && typeof data.shares === "object" && data.shares ? data : { shares: {} };
}

// Upsert one share record under an exclusive lock. Serializes the read-modify-write
// so a CLI share and a canvas-initiated share (via the bridge) can't drop each
// other's record. Written 0o600 because it holds the secret update_key + password.
export function recordShare(fp, slug, rec) {
  withLock(fp + ".lock", () => {
    const data = readShares(fp);
    data.shares[slug] = rec;
    writeJsonAtomic(fp, data, { mode: 0o600 });
  });
}

export function getShare(fp, slug) {
  return readShares(fp).shares[slug] || null;
}

// All records as an array, newest first, each stamped with its slug.
export function listShares(fp) {
  const shares = readShares(fp).shares;
  return Object.keys(shares)
    .map((slug) => ({ slug, ...shares[slug] }))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

function cmdRecord() {
  const slug = env.SLUG;
  if (!slug) {
    process.stderr.write("glimpse-shares.mjs record: missing SLUG\n");
    process.exit(2);
  }
  const visibility = env.VISIBILITY === "public" ? "public" : "private";
  const rec = {
    url: env.URL || "",
    site_id: env.SITE_ID || "",
    update_key: env.UPDATE_KEY || "",
    visibility,
    ts: parseInt(env.TS, 10) || Math.floor(Date.now() / 1000),
  };
  // Store the password only for a private share (public pages have none).
  if (visibility === "private" && env.PASSWORD) rec.password = env.PASSWORD;
  recordShare(sharesPath(), slug, rec);
}

function cmdGet() {
  const slug = env.SLUG;
  if (!slug) {
    process.stderr.write("glimpse-shares.mjs get: missing SLUG\n");
    process.exit(2);
  }
  const rec = getShare(sharesPath(), slug);
  if (!rec) {
    if (env.SHARES_JSON === "1") process.stdout.write("null\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ slug, ...rec }) + "\n");
}

function cmdList() {
  const recs = listShares(sharesPath());
  if (env.SHARES_JSON === "1") {
    process.stdout.write(JSON.stringify({ shares: recs }) + "\n");
    return;
  }
  if (!recs.length) {
    process.stdout.write("(no shares)\n");
    return;
  }
  const now = Date.now() / 1000;
  for (const r of recs) {
    const age = now - (r.ts || now);
    const d =
      age < 3600
        ? `${Math.floor(age / 60)}m`
        : age < 86400
          ? `${Math.floor(age / 3600)}h`
          : `${Math.floor(age / 86400)}d`;
    process.stdout.write(
      `${(r.slug || "").padEnd(26)} ${(r.visibility || "").padEnd(7)} ${d.padStart(4)}  ${r.url || ""}\n`,
    );
  }
}

const DISPATCH = { record: cmdRecord, get: cmdGet, list: cmdList };

// import.meta guard: exported helpers stay unit-testable without running the CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
  const sub = process.argv[2] || "";
  const fn = DISPATCH[sub];
  if (!fn) {
    process.stderr.write(
      `glimpse-shares.mjs: unknown subcommand ${JSON.stringify(sub)}\n`,
    );
    process.exit(2);
  }
  fn();
}
