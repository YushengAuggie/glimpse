// test_glimpse_shares.mjs — round-trip the shares store (lib/glimpse-shares.mjs).
// Node stdlib only, no browser. Drives the real exported functions plus the CLI
// subcommands over a temp GLIMPSE_DIR so both the in-process and spawned paths are
// covered.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  recordShare,
  getShare,
  listShares,
  readShares,
} from "../lib/glimpse-shares.mjs";

const MOD = fileURLToPath(new URL("../lib/glimpse-shares.mjs", import.meta.url));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glimpse-shares-"));
}

test("record → get round-trips a private share with all fields", () => {
  const dir = tmpDir();
  const fp = path.join(dir, "shares.json");
  recordShare(fp, "arch", {
    url: "https://abc.ht-ml.app/",
    site_id: "abc",
    update_key: "key-123",
    visibility: "private",
    password: "hunter2",
    ts: 1751000000,
  });
  const rec = getShare(fp, "arch");
  assert.equal(rec.url, "https://abc.ht-ml.app/");
  assert.equal(rec.site_id, "abc");
  assert.equal(rec.update_key, "key-123");
  assert.equal(rec.visibility, "private");
  assert.equal(rec.password, "hunter2");
  assert.equal(rec.ts, 1751000000);
});

test("missing slug returns null", () => {
  const dir = tmpDir();
  const fp = path.join(dir, "shares.json");
  assert.equal(getShare(fp, "nope"), null);
});

test("shares.json is written 0600 (holds update_key + password)", () => {
  const dir = tmpDir();
  const fp = path.join(dir, "shares.json");
  recordShare(fp, "s", { url: "u", site_id: "i", update_key: "k", visibility: "private", password: "p", ts: 1 });
  const mode = fs.statSync(fp).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
});

test("re-recording the same slug overwrites (upsert, not append)", () => {
  const dir = tmpDir();
  const fp = path.join(dir, "shares.json");
  recordShare(fp, "x", { url: "old", site_id: "i", update_key: "k1", visibility: "private", password: "p", ts: 1 });
  recordShare(fp, "x", { url: "new", site_id: "i", update_key: "k2", visibility: "public", ts: 2 });
  const all = readShares(fp).shares;
  assert.equal(Object.keys(all).length, 1);
  assert.equal(all.x.url, "new");
  assert.equal(all.x.update_key, "k2");
  assert.equal(all.x.visibility, "public");
});

test("listShares returns newest first, stamped with slug", () => {
  const dir = tmpDir();
  const fp = path.join(dir, "shares.json");
  recordShare(fp, "older", { url: "a", site_id: "i", update_key: "k", visibility: "public", ts: 100 });
  recordShare(fp, "newer", { url: "b", site_id: "j", update_key: "k", visibility: "private", password: "p", ts: 200 });
  const list = listShares(fp);
  assert.equal(list.length, 2);
  assert.equal(list[0].slug, "newer");
  assert.equal(list[1].slug, "older");
});

test("CLI record → get/list JSON matches env-passed fields", () => {
  const dir = tmpDir();
  const runEnv = { ...process.env, GLIMPSE_DIR: dir };
  execFileSync("node", [MOD, "record"], {
    env: {
      ...runEnv,
      SLUG: "cli",
      URL: "https://z.ht-ml.app/",
      SITE_ID: "z",
      UPDATE_KEY: "uk",
      VISIBILITY: "private",
      PASSWORD: "pw",
      TS: "1751111111",
    },
  });
  const got = execFileSync("node", [MOD, "get"], {
    env: { ...runEnv, SLUG: "cli", SHARES_JSON: "1" },
    encoding: "utf8",
  });
  const rec = JSON.parse(got);
  assert.equal(rec.slug, "cli");
  assert.equal(rec.url, "https://z.ht-ml.app/");
  assert.equal(rec.password, "pw");
  assert.equal(rec.visibility, "private");

  const list = JSON.parse(
    execFileSync("node", [MOD, "list"], {
      env: { ...runEnv, SHARES_JSON: "1" },
      encoding: "utf8",
    }),
  );
  assert.equal(list.shares.length, 1);
  assert.equal(list.shares[0].slug, "cli");
});

test("CLI get exits 1 for an unknown slug", () => {
  const dir = tmpDir();
  let code = 0;
  try {
    execFileSync("node", [MOD, "get"], {
      env: { ...process.env, GLIMPSE_DIR: dir, SLUG: "ghost", SHARES_JSON: "1" },
      encoding: "utf8",
    });
  } catch (e) {
    code = e.status;
  }
  assert.equal(code, 1);
});

test("public share does not persist a password even if PASSWORD is set", () => {
  const dir = tmpDir();
  execFileSync("node", [MOD, "record"], {
    env: {
      ...process.env,
      GLIMPSE_DIR: dir,
      SLUG: "pub",
      URL: "u",
      SITE_ID: "i",
      UPDATE_KEY: "k",
      VISIBILITY: "public",
      PASSWORD: "leaked",
      TS: "1",
    },
  });
  const rec = getShare(path.join(dir, "shares.json"), "pub");
  assert.equal(rec.visibility, "public");
  assert.equal(rec.password, undefined);
});
