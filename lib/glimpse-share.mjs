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
//   GLIMPSE_HTML_APP_TOKEN  optional bearer token (never required).
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

  const password = process.env.GLIMPSE_PASSWORD || "";
  const body = { html_content: html };
  if (password) body.password = password;

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const token = (process.env.GLIMPSE_HTML_APP_TOKEN || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  let resp;
  try {
    resp = await fetch(`${base}/sites`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
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
  const url = payload.url;
  if (!url) {
    process.stderr.write(
      `glimpse share: unexpected response from ht-ml.app: ${JSON.stringify(payload)}\n`,
    );
    return 1;
  }

  process.stdout.write(
    JSON.stringify({
      url,
      site_id: payload.site_id || "",
      update_key: payload.update_key || "",
      private: Boolean(password),
    }) + "\n",
  );
  return 0;
}

process.exit(await main());
