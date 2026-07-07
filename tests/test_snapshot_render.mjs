// Unit test for `glimpse snapshot` (lib/glimpse-snapshot.mjs).
//
// The snapshot body is not an importable module — run_cdp splices it after the CDP
// helper and runs it as statements inside an async IIFE, so cdpConnect/fail/console
// are ambient. This test reproduces that shape: it reads the shipped body, wraps it
// in `async () => { … }`, and injects a STUB cdpConnect whose `send` returns a
// canned Accessibility.getFullAXTree. That exercises the real tree-building,
// ignored/structural-node collapsing, uid assignment, indentation, and secret
// scrubbing end to end — with no browser.
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY = readFileSync(join(HERE, "..", "lib", "glimpse-snapshot.mjs"), "utf8");

// A small AX tree covering the cases that matter: a structural `generic` wrapper
// whose children reparent, an `ignored` node that must vanish, a nested link, a
// heading with a level, a checkbox state, and a textbox value carrying a secret.
const NODES = [
  { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Test Page" }, childIds: ["2"] },
  { nodeId: "2", role: { value: "generic" }, parentId: "1", childIds: ["3", "4", "5", "6", "7"] },
  { nodeId: "3", role: { value: "heading" }, name: { value: "Hello" }, parentId: "2", properties: [{ name: "level", value: { value: 2 } }], childIds: [] },
  { nodeId: "4", role: { value: "link" }, name: { value: "Learn more" }, parentId: "2", childIds: ["8"] },
  { nodeId: "8", role: { value: "StaticText" }, name: { value: "Learn more" }, parentId: "4", childIds: [] },
  { nodeId: "5", role: { value: "textbox" }, name: { value: "API key" }, value: { value: "token sk-abcdefghijklmnopqrstuvwxyz0123" }, parentId: "2", childIds: [] },
  { nodeId: "6", role: { value: "button" }, name: { value: "Submit" }, ignored: true, parentId: "2", childIds: [] },
  { nodeId: "7", role: { value: "checkbox" }, name: { value: "Agree" }, parentId: "2", properties: [{ name: "checked", value: { value: true } }], childIds: [] },
];

// Drive the real body with a stubbed CDP channel. `frames` maps frameId → the
// getFullAXTree nodes for that frame; `frameTree`/`owners` describe the frame
// hierarchy so the body's iframe-grafting path is exercised too.
async function runSnapshot({ frames, frameTree, owners = {} }) {
  const lines = [];
  const stubConsole = { log: (s) => lines.push(String(s)) };
  const send = async (method, params = {}) => {
    if (method === "Runtime.evaluate") {
      return { result: { value: JSON.stringify({ t: "Test Page", u: "http://127.0.0.1:4321/#demo" }) } };
    }
    if (method === "Page.getFrameTree") return { frameTree };
    if (method === "Accessibility.getFullAXTree") return { nodes: frames[params.frameId] || [] };
    if (method === "DOM.getFrameOwner") return { backendNodeId: owners[params.frameId] };
    return {};
  };
  const cdpConnect = async () => ({ send, waitEvent: async () => ({}), close: () => {} });
  const fail = (e) => { throw e; };
  const run = new Function("cdpConnect", "fail", "console", `return (async () => {\n${BODY}\n})();`);
  await run(cdpConnect, fail, stubConsole);
  return lines.join("\n");
}

// Single main frame carrying the fixture tree above.
const SINGLE = { frames: { main: NODES }, frameTree: { frame: { id: "main" }, childFrames: [] } };
const snap = () => runSnapshot(SINGLE);

const prevUrl = process.env.URL, prevSecret = process.env.SECRET_PATTERN;
test.before(() => { process.env.URL = ""; process.env.SECRET_PATTERN = "sk-[A-Za-z0-9_-]{20,}"; });
test.after(() => {
  if (prevUrl === undefined) delete process.env.URL; else process.env.URL = prevUrl;
  if (prevSecret === undefined) delete process.env.SECRET_PATTERN; else process.env.SECRET_PATTERN = prevSecret;
});

test("emits an axi-style header with title, url, and node count", async () => {
  const out = await snap();
  assert.match(out, /^page:\n {2}title: "Test Page"\n {2}url: "http:\/\/127\.0\.0\.1:4321\/#demo"\n {2}nodes: 6\nsnapshot:/);
});

test("renders an indented role/name tree with per-node uids", async () => {
  const out = await snap();
  assert.match(out, /^uid=s0 RootWebArea "Test Page"$/m);
  assert.match(out, /^ {2}uid=s1 heading "Hello" level="2"$/m);   // reparented out of the generic wrapper, depth 1
  assert.match(out, /^ {2}uid=s2 link "Learn more"$/m);
  assert.match(out, /^ {4}uid=s3 StaticText "Learn more"$/m);      // nested one level under the link
  assert.match(out, /^ {2}uid=s\d+ checkbox "Agree" checked="true"$/m);
});

test("collapses structural (generic) and ignored nodes", async () => {
  const out = await snap();
  assert.doesNotMatch(out, /generic/);          // the wrapper is gone
  assert.doesNotMatch(out, /"Submit"/);          // the ignored button is gone
});

test("scrubs secrets out of captured values", async () => {
  const out = await snap();
  assert.doesNotMatch(out, /sk-abcdefghijklmnopqrstuvwxyz0123/);
  assert.match(out, /textbox "API key" value="token \[REDACTED\]"/);
});

test("grafts a child frame's tree under its owning Iframe node", async () => {
  // Main frame: RootWebArea → Iframe (the <iframe> element carries backendDOMNodeId
  // 900). Child frame "child": its RootWebArea + a heading. The body must resolve the
  // frame owner (backendNodeId 900) and nest the child's root under the Iframe node.
  const out = await runSnapshot({
    frameTree: { frame: { id: "main" }, childFrames: [{ frame: { id: "child" }, childFrames: [] }] },
    owners: { child: 900 },
    frames: {
      main: [
        { nodeId: "m1", role: { value: "RootWebArea" }, name: { value: "Shell" }, childIds: ["m2"] },
        { nodeId: "m2", role: { value: "Iframe" }, name: { value: "Artifact" }, parentId: "m1", backendDOMNodeId: 900, childIds: [] },
      ],
      child: [
        { nodeId: "c1", role: { value: "RootWebArea" }, name: { value: "Inner" }, childIds: ["c2"] },
        { nodeId: "c2", role: { value: "heading" }, name: { value: "Deep content" }, parentId: "c1", childIds: [] },
      ],
    },
  });
  // Iframe at depth 1, its child frame's RootWebArea at depth 2, the heading at depth 3.
  assert.match(out, /^ {2}uid=s\d+ Iframe "Artifact"$/m);
  assert.match(out, /^ {4}uid=s\d+ RootWebArea "Inner"$/m);
  assert.match(out, /^ {6}uid=s\d+ heading "Deep content"$/m);
});
