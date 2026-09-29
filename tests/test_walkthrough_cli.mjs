import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fixture, repo } from "./walkthrough-fixture.mjs";
const cli = path.resolve("bin/glimpse");
function setup(t) {
  const root = repo(t),
    dir = path.join(root, "state"),
    input = path.join(root, "spec.json");
  fs.writeFileSync(input, JSON.stringify(fixture()));
  const env = {
    ...process.env,
    GLIMPSE_DIR: dir,
    GLIMPSE_AUDIT: "0",
    GLIMPSE_CDP_PORT: "59991",
  };
  const run = (args, extra = {}) =>
    spawnSync("bash", [cli, ...args], {
      env: { ...env, ...extra },
      encoding: "utf8",
      timeout: 10000,
    });
  return { root, dir, input, run };
}
test("build publishes a self-contained executable artifact without overwriting a slug", (t) => {
  const { root, dir, input, run } = setup(t);
  const built = run([
    "walkthrough",
    "tour",
    "A </script> title",
    input,
    "--repo",
    root,
  ]);
  assert.equal(built.status, 0, built.stderr);
  const html = fs.readFileSync(path.join(dir, "artifacts/tour.html"), "utf8");
  const payload = JSON.parse(
    html.match(
      /id="walkthrough-spec" type="application\/json">([^]*?)<\/script>/,
    )[1],
  );
  assert.equal(payload.title, "A </script> title");
  assert.ok(!html.includes(root));
  const script = html.match(/<script>([^]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.equal(
    run(["walkthrough", "tour", "Replace", input, "--repo", root]).status,
    2,
  );
  assert.equal(
    fs.readFileSync(path.join(dir, "artifacts/tour.html"), "utf8"),
    html,
  );
});
test("invalid generation leaves no artifact, binding or feed entry", (t) => {
  const { root, dir, input, run } = setup(t);
  fs.writeFileSync(input, JSON.stringify({ ...fixture(), frames: [] }));
  assert.equal(
    run(["walkthrough", "bad", "Bad", input, "--repo", root]).status,
    2,
  );
  assert.equal(fs.existsSync(path.join(dir, "artifacts/bad.html")), false);
  assert.equal(fs.existsSync(path.join(dir, ".walkthrough/bad")), false);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dir, "feed.json"))).artifacts,
    [],
  );
});
test("reconnect restores a saved question already delivered by a prior session", (t) => {
  const { root, dir, input, run } = setup(t);
  assert.equal(
    run(["walkthrough", "tour", "Tour", input, "--repo", root]).status,
    0,
  );
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(dir, ".walkthrough/tour/snapshot.json")),
  );
  const anchor = {
    kind: "node",
    id: "end",
    frame: "child",
    block: "child_b0",
    revision: snapshot.revision,
  };
  const added = run(["__thread-add-user"], {
    SLUG: "tour",
    ANCHOR: JSON.stringify(anchor),
    TEXT: "Why?",
    CLIENT_TURN_ID: "question-1",
  });
  assert.equal(added.status, 0, added.stderr);
  const first = JSON.parse(run(["walkthrough", "connect", "tour"]).stdout);
  const poll = run([
    "poll",
    "--walkthrough",
    "tour",
    "--session",
    first.session,
    "--json",
    "--timeout",
    "1",
  ]);
  assert.equal(poll.status, 0, poll.stderr);
  assert.equal(JSON.parse(poll.stdout).items[0].id, added.stdout.trim());
  assert.equal(
    run(["walkthrough", "disconnect", "tour", first.session]).status,
    0,
  );
  const second = JSON.parse(run(["walkthrough", "connect", "tour"]).stdout);
  assert.equal(second.pending[0].id, added.stdout.trim());
  const resumed = run([
    "poll",
    "--walkthrough",
    "tour",
    "--session",
    second.session,
    "--json",
    "--timeout",
    "1",
  ]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).items[0].id, added.stdout.trim());
});
test("installed flat assets and symlinked module entry points execute the generator", (t) => {
  const { root, dir, input } = setup(t);
  const install = path.join(root, "installed");
  fs.mkdirSync(path.join(install, "bin"), { recursive: true });
  fs.copyFileSync(cli, path.join(install, "bin/glimpse"));
  fs.mkdirSync(dir, { recursive: true });
  for (const folder of ["lib", "canvas"])
    for (const name of fs.readdirSync(folder)) {
      if (fs.statSync(path.join(folder, name)).isFile())
        fs.symlinkSync(path.resolve(folder, name), path.join(dir, name));
    }
  const run = (...args) =>
    spawnSync("bash", [path.join(install, "bin/glimpse"), ...args], {
      encoding: "utf8",
      env: { ...process.env, GLIMPSE_DIR: dir, GLIMPSE_AUDIT: "0" },
    });
  const built = run(
    "walkthrough",
    "installed",
    "Installed",
    input,
    "--repo",
    root,
  );
  assert.equal(built.status, 0, built.stderr);
  assert.match(
    fs.readFileSync(path.join(dir, "artifacts/installed.html"), "utf8"),
    /id="walkthrough-spec"/,
  );
  const context = run("walkthrough", "context", "installed");
  assert.equal(JSON.parse(context.stdout).slug, "installed");
});
test("bad subcommand arguments and expired poll sessions produce actionable errors", (t) => {
  const { root, input, run } = setup(t);
  assert.equal(
    run(["walkthrough", "tour", "Tour", input, "--repo", root]).status,
    0,
  );
  const missing = run(["walkthrough", "evidence", "tour"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /usage:.*evidence/);
  const poll = run([
    "poll",
    "--walkthrough",
    "tour",
    "--session",
    "wrong",
    "--timeout",
    "1",
  ]);
  assert.notEqual(poll.status, 0);
  assert.match(poll.stderr, /reconnect/);
  assert.doesNotMatch(poll.stderr, /node:internal|execFileSync|Uint8Array/);
});
