// test_glimpse_share_request.mjs — the pure request-building helpers of
// lib/glimpse-share.mjs (planRequest / shapeResult). The ht-ml.app anchor rightly
// forbids a loopback mock host, so the POST-vs-PUT + password semantics are proven
// here without the network. Node stdlib only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { planRequest, shapeResult } from "../lib/glimpse-share.mjs";

const BASE = "https://api.ht-ml.app/v1";
const HTML = "<html></html>";

test("create (no update env): POST /sites, password only when set", () => {
  const pub = planRequest({}, HTML, BASE);
  assert.equal(pub.method, "POST");
  assert.equal(pub.endpoint, `${BASE}/sites`);
  assert.equal(pub.isUpdate, false);
  assert.equal("password" in pub.body, false); // public create omits it
  assert.equal(pub.headers.Authorization, undefined);

  const priv = planRequest({ GLIMPSE_PASSWORD: "pw" }, HTML, BASE);
  assert.equal(priv.body.password, "pw");
});

test("create with optional bearer token sets Authorization (create only)", () => {
  const p = planRequest({ GLIMPSE_HTML_APP_TOKEN: "tok" }, HTML, BASE);
  assert.equal(p.headers.Authorization, "Bearer tok");
});

test("update (site_id + key): PUT /sites/<id> with owner-key bearer, password ALWAYS sent", () => {
  const upPriv = planRequest(
    { GLIMPSE_UPDATE_SITE_ID: "s1", GLIMPSE_UPDATE_KEY: "K", GLIMPSE_PASSWORD: "pw" },
    HTML,
    BASE,
  );
  assert.equal(upPriv.method, "PUT");
  assert.equal(upPriv.endpoint, `${BASE}/sites/s1`);
  assert.equal(upPriv.isUpdate, true);
  assert.equal(upPriv.headers.Authorization, "Bearer K"); // update_key, not app token
  assert.equal(upPriv.body.password, "pw");

  // Update to PUBLIC clears the password by sending "" (not omitting it).
  const upPub = planRequest(
    { GLIMPSE_UPDATE_SITE_ID: "s1", GLIMPSE_UPDATE_KEY: "K", GLIMPSE_PASSWORD: "" },
    HTML,
    BASE,
  );
  assert.equal("password" in upPub.body, true);
  assert.equal(upPub.body.password, "");
});

test("update ignores the app token; only the update_key authorizes writes", () => {
  const p = planRequest(
    {
      GLIMPSE_UPDATE_SITE_ID: "s1",
      GLIMPSE_UPDATE_KEY: "K",
      GLIMPSE_HTML_APP_TOKEN: "tok",
    },
    HTML,
    BASE,
  );
  assert.equal(p.headers.Authorization, "Bearer K");
});

test("shapeResult (create): takes url/site_id/update_key from the payload", () => {
  const plan = planRequest({ GLIMPSE_PASSWORD: "pw" }, HTML, BASE);
  const r = shapeResult(
    { url: "https://x.ht-ml.app/", site_id: "x", update_key: "KEY" },
    plan,
    { GLIMPSE_PASSWORD: "pw" },
  );
  assert.deepEqual(r, {
    ok: true,
    url: "https://x.ht-ml.app/",
    site_id: "x",
    update_key: "KEY",
    private: true,
  });
});

test("shapeResult (update): falls back to known url/site_id/key when PUT omits them", () => {
  const env = {
    GLIMPSE_UPDATE_SITE_ID: "s1",
    GLIMPSE_UPDATE_KEY: "K",
    GLIMPSE_UPDATE_URL: "https://s1.ht-ml.app/",
    GLIMPSE_PASSWORD: "pw",
  };
  const plan = planRequest(env, HTML, BASE);
  const r = shapeResult({}, plan, env); // PUT returned nothing useful
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://s1.ht-ml.app/");
  assert.equal(r.site_id, "s1");
  assert.equal(r.update_key, "K"); // unchanged on update
  assert.equal(r.private, true);
});

test("shapeResult: no url anywhere ⇒ ok:false", () => {
  const plan = planRequest({}, HTML, BASE);
  const r = shapeResult({}, plan, {});
  assert.equal(r.ok, false);
});
