// glimpse interact — the explicit, opt-in browser interactions that drive a live
// app to a state worth reviewing: click / scroll / wait. These are the ONLY glimpse
// verbs that intentionally CHANGE page state; read / shot / snapshot never mutate.
// Each is its own verb, so a state change is always a deliberate command, never a
// side effect of reading.
//
// Spliced after lib/glimpse-cdp.mjs by run_cdp(), so cdpConnect / cdpConnectApp /
// fail are in scope. No import/export — statements inside run_cdp's async IIFE.
//
// Acts on the CURRENT live-app tab (cdpConnectApp with no URL prefers the non-canvas
// page), so the flow is: `glimpse open <url>` once, then click/scroll/wait against
// that page. Read-only where it can be (wait just polls); output is JSON and any
// captured element text is secret-scrubbed against SECRET_PATTERN.
//
// env: ACTION (click|scroll|wait) SELECTOR TEXT SCROLL_TO SCROLL_BY TIMEOUT_MS SECRET_PATTERN.

const action = process.env.ACTION || "";
const selector = process.env.SELECTOR || "";
const wantText = process.env.TEXT || "";
const timeoutMs = Math.max(0, Number(process.env.TIMEOUT_MS || "8000")) || 8000;

let secretRe = null;
const pat = process.env.SECRET_PATTERN || "";
if (pat) { try { secretRe = new RegExp("(" + pat + ")", "g"); } catch { secretRe = null; } }
const scrub = (s) => { s = (s == null ? "" : String(s)); return secretRe ? s.replace(secretRe, "[REDACTED]") : s; };

const { send, close } = await cdpConnectApp("");
await send("Page.enable");
await send("Runtime.enable");

// Evaluate an expression in the page; surface a page-side throw as an error rather
// than a silent empty result.
async function evalIn(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails, ex = d.exception || {};
    throw new Error(ex.description || d.text || "page evaluation failed");
  }
  return r.result.value;
}

const sel = JSON.stringify(selector);
let result;

if (action === "click") {
  if (!selector) { console.error("glimpse: click needs a CSS selector"); close(); process.exit(1); }
  // scrollIntoView first (so off-screen controls are clickable), then el.click().
  result = await evalIn(
    `(()=>{const el=document.querySelector(${sel});` +
    `if(!el)return{ok:false,action:"click",reason:"not-found",selector:${sel}};` +
    `el.scrollIntoView({block:"center",inline:"center"});` +
    `const t=(el.innerText||el.value||el.getAttribute("aria-label")||"").trim();` +
    `el.click();` +
    `return{ok:true,action:"click",selector:${sel},tag:el.tagName.toLowerCase(),text:t.slice(0,120)};})()`
  );
} else if (action === "scroll") {
  const to = process.env.SCROLL_TO || "", by = process.env.SCROLL_BY || "";
  let js;
  if (selector) {
    js = `(()=>{const el=document.querySelector(${sel});` +
      `if(!el)return{ok:false,action:"scroll",reason:"not-found",selector:${sel}};` +
      `el.scrollIntoView({block:"center",inline:"center"});` +
      `return{ok:true,action:"scroll",into:${sel},scrollY:Math.round(window.scrollY)};})()`;
  } else if (to !== "") {
    const n = Number(to) || 0;
    js = `(()=>{window.scrollTo(0,${n});return{ok:true,action:"scroll",to:${n},scrollY:Math.round(window.scrollY)};})()`;
  } else {
    const n = Number(by) || 0;
    js = `(()=>{window.scrollBy(0,${n});return{ok:true,action:"scroll",by:${n},scrollY:Math.round(window.scrollY)};})()`;
  }
  result = await evalIn(js);
} else if (action === "wait") {
  if (!selector && !wantText) { console.error("glimpse: wait needs a CSS selector or --text"); close(); process.exit(1); }
  const probe = selector
    ? `(()=>{const el=document.querySelector(${sel});return !!(el&&(el.offsetParent!==null||el.getClientRects().length));})()`
    : `(()=>{return (document.body?document.body.innerText:"").includes(${JSON.stringify(wantText)});})()`;
  const forWhat = selector || ("text:" + wantText);
  const deadline = Date.now() + timeoutMs;
  let ok = false;
  while (Date.now() < deadline) {
    try { if (await evalIn(probe)) { ok = true; break; } } catch (_) { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  result = ok ? { ok: true, action: "wait", for: forWhat } : { ok: false, action: "wait", reason: "timeout", for: forWhat };
} else {
  console.error("glimpse: unknown interact action '" + action + "'"); close(); process.exit(1);
}

close();
if (result && result.text) result.text = scrub(result.text).slice(0, 120);
console.log(JSON.stringify(result));
if (result && result.ok === false) process.exit(2);
