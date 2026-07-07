#!/usr/bin/env node
// glimpse-chrome-profile.mjs — patch (never overwrite) the automation Chrome
// profile so its toolbar chip reads the Glimpse label instead of a Google account
// name. Chrome shows the name from Local State's info_cache (the authoritative
// display name), so patch that as well as per-profile Preferences. Invoked as a
// CLI by `bin/glimpse` (best-effort; errors are swallowed by the caller).
// Node stdlib only. Ported from the former glimpse_chrome_profile.py.
//
//   GLIMPSE_PROFILE_LABEL="🤖 Glimpse (automation)" glimpse-chrome-profile.mjs <profile-dir>

import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
const label = process.env.GLIMPSE_PROFILE_LABEL;
const sub = "Default";

function load(p) {
  try {
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  } catch {
    return {};
  }
}

const prefs = path.join(root, sub, "Preferences");
const d = load(prefs);
if (typeof d.profile !== "object" || d.profile === null) d.profile = {};
d.profile.name = label;
fs.mkdirSync(path.dirname(prefs), { recursive: true });
fs.writeFileSync(prefs, JSON.stringify(d));

const lp = path.join(root, "Local State");
const ls = load(lp);
if (typeof ls.profile !== "object" || ls.profile === null) ls.profile = {};
if (typeof ls.profile.info_cache !== "object" || ls.profile.info_cache === null)
  ls.profile.info_cache = {};
if (
  typeof ls.profile.info_cache[sub] !== "object" ||
  ls.profile.info_cache[sub] === null
)
  ls.profile.info_cache[sub] = {};
ls.profile.info_cache[sub].name = label;
ls.profile.info_cache[sub].is_using_default_name = false;
fs.writeFileSync(lp, JSON.stringify(ls));
