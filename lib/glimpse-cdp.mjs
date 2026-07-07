// Shared Chrome DevTools Protocol client for glimpse. `cdpConnect(pick)` finds a
// target (pick = Array.find predicate over /json) or opens a new tab, with per-call
// timeouts, error rejection, and a close handler so nothing hangs forever.
//
// Spliced ahead of a per-verb body by run_cdp() and ahead of glimpse-bridge.mjs by
// cmd_bridge() (node --input-type=module -e), so it runs as an ES module. This file
// is the verbatim former CDP_HELPER heredoc from bin/glimpse — no import/export.
const base=`http://127.0.0.1:${process.env.CDP_PORT}`;
async function cdpConnect(pick){
  const targets=await fetch(`${base}/json`).then(r=>r.json());
  let p = pick ? targets.find(pick) : null;
  if(!p) p = await fetch(`${base}/json/new?about:blank`,{method:"PUT"}).then(r=>r.json())
              .catch(()=>fetch(`${base}/json/new?about:blank`).then(r=>r.json()));
  if(!p || !p.webSocketDebuggerUrl) throw new Error("no CDP target available");
  const ws=new WebSocket(p.webSocketDebuggerUrl); const m=new Map(); let id=0;
  await new Promise((res,rej)=>{ ws.addEventListener("open",res);
    ws.addEventListener("error",()=>rej(new Error("CDP websocket error")));
    setTimeout(()=>rej(new Error("CDP open timeout")),8000); });
  const evw=[]; const subs=new Map();   // one-shot waiters (waitEvent) + persistent listeners (on)
  ws.addEventListener("message",e=>{ const d=JSON.parse(e.data);
    if(d.id){ const h=m.get(d.id); if(h){ m.delete(d.id); clearTimeout(h.to);
      d.error?h.rej(new Error(d.error.message)):h.res(d.result); } }
    else if(d.method){
      const hs=subs.get(d.method); if(hs) for(const fn of hs){ try{ fn(d.params); }catch(_){} }
      for(let i=evw.length-1;i>=0;i--) if(evw[i].method===d.method){
        const w=evw.splice(i,1)[0]; clearTimeout(w.to); w.res(d.params); } }
  });
  ws.addEventListener("close",()=>{ for(const h of m.values()){clearTimeout(h.to);h.rej(new Error("CDP connection closed"));} m.clear(); });
  const send=(M,P={})=>new Promise((res,rej)=>{ const i=++id;
    const to=setTimeout(()=>{m.delete(i);rej(new Error(M+" timeout"));},15000);
    m.set(i,{res,rej,to}); ws.send(JSON.stringify({id:i,method:M,params:P})); });
  const waitEvent=(method,ms=10000)=>new Promise((res,rej)=>{ const w={method,res,rej};
    w.to=setTimeout(()=>{const i=evw.indexOf(w);if(i>=0)evw.splice(i,1);rej(new Error(method+" timeout"));},ms);
    evw.push(w); });
  // Persistent event subscription (unlike waitEvent's one-shot). Used to accumulate
  // a page's console output / uncaught errors across a navigation. Returns an
  // unsubscribe. No-op cost when nothing subscribes (empty map in the hot path).
  const on=(method,handler)=>{ let s=subs.get(method); if(!s){ s=new Set(); subs.set(method,s); } s.add(handler);
    return ()=>{ const t=subs.get(method); if(t){ t.delete(handler); if(!t.size) subs.delete(method); } }; };
  return { target:p, send, waitEvent, on, close:()=>ws.close() };
}

// Pick the page target to DRIVE for live-app review, reusing the ONE shared client
// (never a second browser connection). With a target URL, match its host so we act
// on the app's own tab — cdpConnect opens a fresh tab if none exists, so we reuse
// the app tab and never navigate the canvas away (exactly how `glimpse open`
// chooses). With no URL, prefer a non-canvas page (the app under review) over the
// canvas tab, then fall back to any page / a new tab. `PORT` (canvas port) is read
// from the env glimpse already exports.
async function cdpConnectApp(targetUrl){
  const port=process.env.PORT||"";
  const hostOf=(u)=>{ try{ return new URL(u).host; }catch{ return ""; } };
  const isCanvas=(u)=>{ const h=hostOf(u); return !!port && (h===`127.0.0.1:${port}`||h===`localhost:${port}`); };
  if(targetUrl){
    const want=hostOf(targetUrl);
    return cdpConnect(x=>x.type==="page" && !!want && hostOf(x.url)===want);
  }
  const targets=await fetch(`${base}/json`).then(r=>r.json()).catch(()=>[]);
  const app=targets.find(t=>t.type==="page" && !isCanvas(t.url));
  return cdpConnect(app ? (x=>x.id===app.id) : (x=>x.type==="page"));
}
function fail(e){ console.error("glimpse:", (e&&e.message)||e, "— is Chrome running? try: glimpse chrome"); process.exit(1); }
