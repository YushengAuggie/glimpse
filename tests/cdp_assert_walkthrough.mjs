// Opt-in real-browser checks. Run against an isolated Glimpse canvas containing
// examples/walkthrough-ask.json; never navigates an existing user's canvas.
import fs from "node:fs";
import assert from "node:assert/strict";
const base = `http://127.0.0.1:${process.env.GLIMPSE_CDP_PORT || 9222}`;
const targets = await fetch(base + "/json").then((r) => r.json());
const target = targets.find(
  (t) => t.type === "iframe" && t.url === "about:srcdoc",
);
assert.ok(target, "open the isolated walkthrough canvas first");
const ws = new WebSocket(target.webSocketDebuggerUrl),
  pending = new Map();
let next = 0;
await new Promise((resolve) =>
  ws.addEventListener("open", resolve, { once: true }),
);
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
const errors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params);
});
try {
  await send("Runtime.enable");
  const spec = await evaluate(
    'JSON.parse(document.querySelector("#walkthrough-spec").textContent)',
  );
  assert.equal(
    await evaluate('document.querySelector(".wt-panel").hidden'),
    true,
    "code initially hidden",
  );
  assert.equal(await evaluate("scrollY"), 0, "no initial page scroll");
  const graphWidth = await evaluate(
    'document.querySelector(".wt-graph").clientWidth',
  );
  for (const node of spec.nodes) {
    const result = await evaluate(
      `(()=>{document.getElementById(${JSON.stringify("n_" + node.id)}).click();return {frame:document.querySelector('.wt-panel-title h2').textContent,active:[...document.querySelectorAll('.wt-active-block')].map(b=>b.id),width:document.querySelector('.wt-graph').clientWidth}})()`,
    );
    const frame = spec.frames.find((f) => f.id === node.frame);
    assert.equal(result.frame, frame.name);
    assert.deepEqual(
      result.active,
      node.blocks.map((i) => "block_" + frame.blocks[i].id),
    );
    assert.equal(
      result.width,
      graphWidth,
      "inspector must not reduce graph width",
    );
    const crumbs = await evaluate(
      '[...document.querySelectorAll(".wt-stack button")].map(b=>b.textContent)',
    );
    for (let i = 0; i < crumbs.length; i++) {
      const view = await evaluate(
        `(()=>{document.querySelectorAll('.wt-stack button')[${i}].click(); const p=document.querySelector('.wt-panel'); const b=document.querySelector('.wt-active-block');return {name:document.querySelector('.wt-panel-title h2').textContent,top:b?.getBoundingClientRect().top,panel:p.getBoundingClientRect().top}})()`,
      );
      assert.equal(view.name, crumbs[i]);
      if (i < crumbs.length - 1)
        assert.ok(
          Math.abs(view.top - view.panel) < 2,
          "stack click scrolls caller block",
        );
    }
  }
  let checked = 0;
  for (const frame of spec.frames)
    for (const block of frame.blocks) {
      const actual = fs
        .readFileSync(frame.file, "utf8")
        .split("\n")
        .slice(block.start - 1, block.end)
        .join("\n");
      assert.equal(block.raw, actual, `${frame.file}:${block.start}`);
      checked++;
    }
  assert.ok(checked >= 5, "spot check at least five blocks");
  await evaluate(
    `document.getElementById('n_messages').click();document.querySelector('.wt-block-head button').click()`,
  );
  const visible = await evaluate(
    `(()=>{const q=document.querySelector('.wt-composer textarea').getBoundingClientRect(),p=document.querySelector('.wt-panel').getBoundingClientRect();return q.top>=p.top&&q.bottom<=p.bottom})()`,
  );
  assert.ok(visible, "Ask reveals textarea in code panel");
  const before = await evaluate(
    'document.querySelector(".wt-separator").getAttribute("aria-valuenow")',
  );
  await evaluate(
    `document.querySelector('.wt-separator').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))`,
  );
  assert.equal(
    Number(
      await evaluate(
        'document.querySelector(".wt-separator").getAttribute("aria-valuenow")',
      ),
    ),
    Number(before) - 2,
  );
  for (const theme of ["dark", "light"]) {
    await evaluate(`window.__applyTheme('${theme}')`);
    assert.equal(
      await evaluate("document.documentElement.dataset.theme"),
      theme,
    );
    assert.equal(
      await evaluate("document.documentElement.scrollWidth<=innerWidth"),
      true,
      "horizontal overflow contained",
    );
  }
  assert.deepEqual(errors, [], "no runtime exceptions");
  console.log(
    `PASS: ${spec.nodes.length} nodes, all stack entries, ${checked} real source blocks, Ask visibility, divider, themes, initial state and graph width`,
  );
} finally {
  ws.close();
}
