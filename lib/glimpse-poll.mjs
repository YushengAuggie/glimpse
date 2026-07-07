// glimpse poll — ONE blocking drain of human feedback for an in-the-loop agent.
//
// Where `glimpse bridge` is a long-lived JSON-line stream you run under a Monitor,
// `poll` is a single call the agent parks on: it blocks until there is undelivered
// feedback (a pending user turn), prints it in a compact structured format (or, with
// --json, plain JSON), then returns. Queued feedback is durable on disk, so nothing
// is dropped if the agent wasn't polling yet, and a second waiting item is delivered
// on the next poll.
//
// It reuses the bridge's drain machinery. Each iteration it (a) drains every canvas
// tab's window.__glimpse_outbox into the flocked thread store — shelling to
// `glimpse __thread-add-user`, idempotent by clientTurnId, so it coexists with a
// running bridge/daemon without double-persisting — then (b) reads pending user turns
// (`glimpse __pending`) and emits the ones this poll cursor hasn't delivered yet. A
// persisted delivered set (.poll.state) makes delivery idempotent across calls
// WITHOUT mutating turn status, so the canvas's "awaiting answer" indicator is
// preserved until you `glimpse reply`.
//
// If Chrome / the canvas is unreachable it degrades to disk-only: it still blocks on
// the durable pending queue (fed by a separate bridge/daemon, or by the CLI). Turn
// text/quote/anchor are already secret-scrubbed at persist time (glimpse-threads.mjs);
// poll only emits fields from that scrubbed store, so it never leaks a scrubbed secret.
//
// Exit codes: 0 = feedback delivered · 3 = timed out with nothing to deliver · 1 =
// (via the CDP helper's fail) an unexpected error. Operational chatter (waiting,
// heartbeat, chrome-unavailable) goes to stderr; stdout carries ONLY the structured
// records / a #timeout marker so a caller can parse it cleanly.
//
// Spliced after glimpse-cdp.mjs by cmd_poll() (node --input-type=module -e), so
// cdpConnect is in scope. Only node: builtins are imported (a -e module can't resolve
// relative imports), matching glimpse-bridge.mjs.
//
// Env in: GLIMPSE_BIN PORT CDP_PORT GLIMPSE_DIR POLL_JSON(0|1) POLL_TIMEOUT_MS POLL_INTERVAL_MS
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync } from "node:fs";

const PORT = process.env.PORT, DIR = process.env.GLIMPSE_DIR, BIN = process.env.GLIMPSE_BIN;
const AS_JSON = process.env.POLL_JSON === "1";
const TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || "300000");   // 0 = wait indefinitely
const INTERVAL_MS = Math.max(100, Number(process.env.POLL_INTERVAL_MS || "500"));
const HEARTBEAT_MS = 30000;
const statePath = DIR + "/.poll.state";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const note = s => process.stderr.write("glimpse: " + s + "\n");

// --- canvas origin (loopback allowlist) --------------------------------------
// The canvas is our static server on the loopback interface; Chrome may reach it as
// 127.0.0.1, localhost, or ::1 — all the same server — so accept ANY loopback host on
// our port, anchored to an explicit allowlist + exact port (never a substring test).
// MUST stay byte-identical to lib/glimpse-bridge.mjs — tests/test_poll.mjs extracts
// both predicates and asserts they match, so this can never drift.
const LOOPBACK_HOSTS=new Set(["127.0.0.1","localhost","[::1]"]);
const isCanvasOrigin=u=>{ try{ const p=new URL(u); return p.protocol==="http:" && LOOPBACK_HOSTS.has(p.hostname) && p.port===String(PORT); }catch{ return false; } };
const isCanvas = t => t.type === "page" && isCanvasOrigin(t.url);

// >>> glimpse-poll format helpers (pure; extracted verbatim by tests/test_poll.mjs)
// The compact format is line-oriented and TOON-like: a self-describing header comment
// declares the field order once, then one TAB-separated record per feedback item.
// Fields with tabs/newlines/backslashes are escaped so a record is always one line.
// Anchor collapses to a compact token (text:<occurrence> | node:<id> | -); the full
// anchor object is available via --json. This is far cheaper for an agent to parse
// than repeated-key JSON, while --json stays available for callers that want it.
const FMT_VERSION = "glimpse-poll v1";
const FMT_FIELDS = ["kind", "thread", "id", "ts", "anchor", "quote", "text"];
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}
function anchorToken(a) {
  if (!a || typeof a !== "object") return "-";
  if (a.kind === "node") return "node:" + esc(a.id || "");
  if (typeof a.exact === "string") return "text:" + (a.occurrence || 0);
  return "-";
}
function toItem(o) {   // o: a pending-turn record from `glimpse __pending`
  return {
    kind: o.type || "question", thread: o.slug || "", id: o.id || "",
    ts: (o.ts != null ? o.ts : ""), anchor: o.anchor || null,
    quote: o.quote || "", text: o.text || "",
  };
}
function fmtCompactHeader() { return "#" + FMT_VERSION + " fields=" + FMT_FIELDS.join(","); }
function fmtCompactRow(it) {
  return [esc(it.kind), esc(it.thread), esc(it.id), esc(it.ts),
    anchorToken(it.anchor), esc(it.quote), esc(it.text)].join("\t");
}
function fmtCompactTimeout(sec) { return "#" + FMT_VERSION + " timeout=" + sec + "s"; }
function jsonPayload(items, timeoutSec, now) {
  const o = { type: "poll", count: items.length, ts: now, items };
  if (timeoutSec != null) o.timeout = timeoutSec;
  return JSON.stringify(o);
}
// <<< glimpse-poll format helpers

// --- delivered cursor (dedup across calls, no status mutation) ---------------
let delivered = new Set();
try { delivered = new Set((JSON.parse(readFileSync(statePath, "utf8")).delivered) || []); } catch {}
function saveState() {
  const arr = [...delivered].slice(-4000);              // bounded; old turn ids never recur
  try { const tmp = statePath + ".tmp"; writeFileSync(tmp, JSON.stringify({ delivered: arr }), { mode: 0o600 }); renameSync(tmp, statePath); } catch {}
}

// All thread writes funnel through the shared flocked Node writer (glimpse-store.mjs,
// via glimpse-threads.mjs) by shelling out to the CLI (idempotent by clientTurnId),
// exactly as the bridge does.
function persistUser(m) {
  const env = {
    ...process.env, SLUG: m.slug || "", QUOTE: m.quote || "", TEXT: m.text || "",
    CLIENT_TURN_ID: m.clientTurnId || m.id || "", ANCHOR: m.anchor ? JSON.stringify(m.anchor) : "",
    ARTIFACT_TS: m.artifactTs != null ? String(m.artifactTs) : "",
  };
  return execFileSync("bash", [BIN, "__thread-add-user"], { env, encoding: "utf8" }).trim().split("\n").pop();
}

// --- browser outbox → durable store (best-effort; disk-only if Chrome is down) --
const CDPBASE = `http://127.0.0.1:${process.env.CDP_PORT}`;
const conns = new Map();          // targetId -> CDP connection, one per open canvas tab
async function listCanvas() {
  try { return (await fetch(CDPBASE + "/json").then(r => r.json())).filter(isCanvas); }
  catch { return null; }          // null → Chrome unreachable
}
async function syncTargets() {
  const canvas = await listCanvas();
  if (canvas === null) return null;
  const ids = new Set(canvas.map(t => t.id));
  for (const t of canvas) if (!conns.has(t.id)) { try { conns.set(t.id, await cdpConnect(x => x.id === t.id)); } catch {} }
  for (const id of [...conns.keys()]) if (!ids.has(id)) { try { conns.get(id).close(); } catch {} conns.delete(id); }
  return conns.size;
}
const EVAL = "(function(){try{window.__glimpse_bridge_live=Date.now();}catch(e){}" +
             "return JSON.stringify({origin:location.origin,outbox:(window.__glimpse_outbox||[])});})()";
const drained = new Set();        // outbox ids handled this run — avoid re-persist churn
async function drainOutbox() {
  const n = await syncTargets();
  if (!n) return;                 // 0 or null: no canvas tab / Chrome down → disk-only this tick
  for (const [id, c] of [...conns]) {
    let data = null;
    try { const r = await c.send("Runtime.evaluate", { expression: EVAL, returnByValue: true }); data = JSON.parse(r.result.value); }
    catch { try { c.close(); } catch {} conns.delete(id); continue; }   // tab closed → drop, re-added next sync
    if (!data || !isCanvasOrigin(data.origin)) continue;
    for (const m of (data.outbox || [])) {
      if (!m || !m.id || drained.has(m.id)) continue;
      drained.add(m.id);
      // pin/unpin are feed-mutation intents, not feedback — route to the CLI exactly
      // like the bridge; never into the thread store or poll output.
      if (m.intent === "pin" || m.intent === "unpin") {
        try { execFileSync("bash", [BIN, m.intent, String(m.slug || "")], { encoding: "utf8" }); } catch {}
        continue;
      }
      // Canvas Export/Share actions are serviced by the bridge/daemon (they run the
      // export/share verbs), never by poll — skip so we don't persist one as a bogus
      // user turn. A UI action while only `poll` is running just falls to its timeout.
      if (m.type === "glimpse:action") continue;
      try { persistUser(m); } catch {}   // idempotent; a failure just leaves it un-persisted for a later tick
    }
  }
}

// --- durable pending queue ---------------------------------------------------
function readPending() {
  const out = [];
  let raw = "";
  try { raw = execFileSync("bash", [BIN, "__pending"], { encoding: "utf8" }); } catch { return out; }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o = null; try { o = JSON.parse(line); } catch { continue; }
    if (o && o.id) out.push(o);
  }
  return out;
}

function cleanup() { for (const c of conns.values()) { try { c.close(); } catch {} } }
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

// --- main loop: block until fresh feedback, then emit + return ---------------
const start = Date.now();
const deadline = TIMEOUT_MS > 0 ? start + TIMEOUT_MS : Infinity;
let lastBeat = start;
note(TIMEOUT_MS > 0
  ? `poll waiting for feedback (timeout ${Math.round(TIMEOUT_MS / 1000)}s)…`
  : "poll waiting for feedback (no timeout — Ctrl-C to stop)…");

while (true) {
  await drainOutbox();                                   // browser → durable store (best-effort)
  const fresh = readPending().filter(o => !delivered.has(o.id));
  if (fresh.length) {
    const now = Math.floor(Date.now() / 1000);
    const items = fresh.map(toItem);
    if (AS_JSON) {
      process.stdout.write(jsonPayload(items, null, now) + "\n");
    } else {
      process.stdout.write(fmtCompactHeader() + "\n");
      for (const it of items) process.stdout.write(fmtCompactRow(it) + "\n");
    }
    for (const o of fresh) delivered.add(o.id);
    saveState();
    cleanup();
    process.exit(0);
  }
  if (Date.now() >= deadline) {
    const sec = Math.round((Date.now() - start) / 1000);
    if (AS_JSON) process.stdout.write(jsonPayload([], sec, Math.floor(Date.now() / 1000)) + "\n");
    else process.stdout.write(fmtCompactTimeout(sec) + "\n");
    cleanup();
    process.exit(3);
  }
  if (Date.now() - lastBeat >= HEARTBEAT_MS) {
    lastBeat = Date.now();
    note(`still waiting… (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
  }
  await sleep(INTERVAL_MS);
}
