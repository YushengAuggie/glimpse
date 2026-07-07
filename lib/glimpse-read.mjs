// glimpse read — navigate the live app (or a given URL) and report what an agent
// needs to review a RUNNING app: its identity, the visible text, and the console
// output + uncaught errors emitted while it loaded. The text/console counterpart
// of `glimpse shot` (pixels) and `glimpse snapshot` (a11y tree).
//
// Spliced after lib/glimpse-cdp.mjs by run_cdp(), so cdpConnect / cdpConnectApp /
// fail are in scope. No import/export — it runs as statements inside run_cdp's
// async IIFE, exactly like the former inline body and like glimpse-snapshot.mjs.
//
// Read-only: it navigates only when handed a URL, never mutates the page. With no
// URL it reads the current app tab (so `glimpse open <url>` then `glimpse read`
// reviews the app you just opened). Names/text/console are secret-scrubbed against
// SECRET_PATTERN (same posture as thread turns / snapshot), so a token that slipped
// into the page or a log line is never surfaced. env: URL SECRET_PATTERN.

const url = process.env.URL || "";

let secretRe = null;
const pat = process.env.SECRET_PATTERN || "";
if (pat) { try { secretRe = new RegExp("(" + pat + ")", "g"); } catch { secretRe = null; } }
const scrub = (s) => {
  s = (s == null ? "" : String(s));
  return secretRe ? s.replace(secretRe, "[REDACTED]") : s;
};

const MAX_TEXT = 8000;   // keep the text dump bounded (was the old inline cap)
const MAX_MSGS = 50;     // most-recent console lines / errors
const MSG_CAP = 300;     // per-message length cap

// Pure formatter, kept self-contained so tests can exercise it with canned data
// (see tests/test_read_render.mjs) — no browser needed.
function formatRead({ title, url, text, console: msgs, errors }) {
  const out = {
    title: scrub(title || ""),
    url: url || "",
    text: scrub((text || "").slice(0, MAX_TEXT)),
    console: (msgs || []).slice(-MAX_MSGS).map((m) => ({
      type: m.type || "log",
      text: scrub(String(m.text == null ? "" : m.text)).slice(0, MSG_CAP),
    })),
    errors: (errors || []).slice(-MAX_MSGS).map((e) => scrub(String(e == null ? "" : e)).slice(0, MSG_CAP)),
  };
  return JSON.stringify(out);
}

const { send, waitEvent, on, close } = await cdpConnectApp(url);
const msgs = [], errors = [];
await send("Page.enable");
await send("Runtime.enable");
// Collect console + uncaught errors emitted during load — the single most useful
// signal when reviewing a running app. Subscribe BEFORE navigating so nothing early
// is missed.
on("Runtime.consoleAPICalled", (p) => {
  const text = (p.args || [])
    .map((a) => (a.value !== undefined ? a.value : (a.description || a.unserializableValue || a.type)))
    .join(" ");
  msgs.push({ type: p.type || "log", text });
});
on("Runtime.exceptionThrown", (p) => {
  const d = p.exceptionDetails || {};
  const ex = d.exception || {};
  errors.push(ex.description || d.text || "uncaught exception");
});

if (url) {
  const loaded = waitEvent("Page.loadEventFired", 12000).catch(() => {});
  await send("Page.navigate", { url });
  await loaded;
}
await new Promise((r) => setTimeout(r, 300));

let data = { title: "", url: "", text: "" };
try {
  const { result } = await send("Runtime.evaluate", {
    expression: 'JSON.stringify({title:document.title,url:location.href,text:(document.body?document.body.innerText:"")})',
    returnByValue: true,
  });
  data = JSON.parse(result.value);
} catch { /* keep empty identity */ }
close();

console.log(formatRead({ title: data.title, url: data.url, text: data.text, console: msgs, errors }));
