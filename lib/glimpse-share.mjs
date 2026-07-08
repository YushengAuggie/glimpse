#!/usr/bin/env node
// glimpse-share.mjs — upload one self-contained HTML document to the ht-ml.app
// hosting API and print the visitable URL + secret update key, invoked as a CLI by
// `bin/glimpse`. Node stdlib only (global fetch), no third-party deps. Ported from
// the former glimpse_share.py (behavior-preserving).
//
//   glimpse-share.mjs            # HTML on stdin
//
// This is the ONLY part of glimpse that reaches the network for a user artifact.
// The endpoint host is anchored to ht-ml.app and cannot be pointed elsewhere — a
// GLIMPSE_HTML_APP_BASE override is validated to that domain before any request.
//
// Env:
//   GLIMPSE_PASSWORD        if non-empty, publish a PRIVATE (password-protected)
//                           page with this shared secret; empty ⇒ fully public.
//   GLIMPSE_HTML_APP_BASE   API base (default https://api.ht-ml.app/v1); host must
//                           be ht-ml.app.
//   GLIMPSE_HTML_APP_TOKEN  optional bearer token (never required) — CREATE only.
//   GLIMPSE_UPDATE_SITE_ID  when set together with GLIMPSE_UPDATE_KEY, UPDATE the
//   GLIMPSE_UPDATE_KEY      existing page in place (PUT /sites/<id>, auth Bearer
//                           <key>) instead of creating a new one — the URL is
//                           preserved. On update the password field is ALWAYS sent
//                           (value sets it, "" clears it → public).
//   GLIMPSE_UPDATE_URL      the existing page URL, echoed back if PUT omits it.
//
// Prints a JSON object to stdout on success:
//   {"url": …, "site_id": …, "update_key": …, "private": true|false}
// On failure, prints an actionable line to stderr and exits non-zero.

import fs from "node:fs";

const DEFAULT_BASE = "https://api.ht-ml.app/v1";
const ALLOWED_DOMAIN = "ht-ml.app";

class ShareError extends Error {}

// The API base, refusing any host that isn't ht-ml.app (anchored match).
function anchoredBase() {
  const base = (process.env.GLIMPSE_HTML_APP_BASE || "").trim() || DEFAULT_BASE;
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw new ShareError(`refusing non-http(s) share endpoint: ${base}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new ShareError(`refusing non-http(s) share endpoint: ${base}`);
  const host = (parsed.hostname || "").toLowerCase();
  if (!(host === ALLOWED_DOMAIN || host.endsWith("." + ALLOWED_DOMAIN)))
    throw new ShareError(`refusing share endpoint outside ${ALLOWED_DOMAIN}: ${base}`);
  return base.replace(/\/+$/, "");
}

// Build the HTTP request (create POST vs update-in-place PUT) from env + HTML.
// Pure — no I/O — so the POST/PUT + password semantics are unit-testable without
// the network (the anchor rightly forbids a loopback mock host). CREATE sends the
// password only when set (absence ⇒ public); UPDATE ALWAYS sends it so visibility
// can flip (value sets it, "" clears it → public).
export function planRequest(env, html, base) {
  const password = env.GLIMPSE_PASSWORD || "";
  const upSite = (env.GLIMPSE_UPDATE_SITE_ID || "").trim();
  const upKey = (env.GLIMPSE_UPDATE_KEY || "").trim();
  const isUpdate = Boolean(upSite && upKey);

  const body = { html_content: html };
  if (isUpdate) body.password = password;
  else if (password) body.password = password;

  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (isUpdate) {
    headers.Authorization = `Bearer ${upKey}`; // owner key required to write
  } else {
    const token = (env.GLIMPSE_HTML_APP_TOKEN || "").trim();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const endpoint = isUpdate
    ? `${base}/sites/${encodeURIComponent(upSite)}`
    : `${base}/sites`;

  return {
    endpoint,
    method: isUpdate ? "PUT" : "POST",
    headers,
    body,
    isUpdate,
    password,
    upSite,
    upKey,
  };
}

// Shape the success payload into the record the CLI persists. On update the PUT
// response omits a fresh update_key (unchanged) and may omit the url; fall back to
// the known values so the caller always gets a complete record.
export function shapeResult(payload, plan, env) {
  const url =
    payload.url || (plan.isUpdate ? env.GLIMPSE_UPDATE_URL || "" : "");
  return {
    ok: Boolean(url),
    url,
    site_id: payload.site_id || plan.upSite || "",
    update_key: payload.update_key || (plan.isUpdate ? plan.upKey : ""),
    private: Boolean(plan.password),
  };
}

async function main() {
  let html = "";
  try {
    html = fs.readFileSync(0, "utf8");
  } catch {
    html = "";
  }
  if (!html.trim()) {
    process.stderr.write("glimpse share: empty document — nothing to upload\n");
    return 1;
  }

  let base;
  try {
    base = anchoredBase();
  } catch (exc) {
    process.stderr.write(`glimpse share: ${exc.message}\n`);
    return 1;
  }

  const plan = planRequest(process.env, html, base);
  const isUpdate = plan.isUpdate;

  let resp;
  try {
    resp = await fetch(plan.endpoint, {
      method: plan.method,
      headers: plan.headers,
      body: JSON.stringify(plan.body),
      signal: AbortSignal.timeout(60000),
    });
  } catch (exc) {
    // Network/timeout failure (urllib.error.URLError analogue).
    const reason = exc && exc.message ? exc.message : String(exc);
    process.stderr.write(`glimpse share: could not reach ${base} — ${reason}\n`);
    return 1;
  }

  if (!resp.ok) {
    let detail = "";
    try {
      const err = JSON.parse(await resp.text());
      detail = err.message || err.detail || "";
    } catch {
      /* non-JSON error body */
    }
    const hint =
      resp.status === 422
        ? " (the HTML failed ht-ml.app's content-safety scan)"
        : isUpdate && resp.status === 403
          ? " (the stored update key is wrong or the page no longer exists — share without --update to make a fresh page)"
          : "";
    process.stderr.write(
      `glimpse share: upload failed — HTTP ${resp.status}${hint}: ${detail}\n`,
    );
    return 1;
  }

  let payload;
  try {
    payload = JSON.parse(await resp.text());
  } catch {
    payload = {};
  }
  const result = shapeResult(payload, plan, process.env);
  if (!result.ok) {
    process.stderr.write(
      `glimpse share: unexpected response from ht-ml.app: ${JSON.stringify(payload)}\n`,
    );
    return 1;
  }

  const { ok, ...record } = result;
  void ok;
  process.stdout.write(JSON.stringify(record) + "\n");
  return 0;
}

// import.meta guard: exported helpers (planRequest/shapeResult) stay importable by
// unit tests without running the network CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main());
}
