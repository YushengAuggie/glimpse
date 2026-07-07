# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Install & doctor conventions

- **`install.sh` is one idempotent command.** It runs a preflight (node ≥22, python3, Chrome) printing `✓`/`✗`/`⚠` with a copy-pasteable, OS-aware fix per line, then installs the CLI + canvas assets regardless. Node and python3 are **required**: if either is missing the installer still installs the CLI (so `glimpse doctor` can re-diagnose) but exits non-zero. Chrome is a **warning only** — it is driven at runtime and doctor re-checks it, so a missing browser never blocks the install. Re-running is always safe.
- **`glimpse doctor` (`cmd_doctor`) is loud and scriptable.** One line per check with a marker: `✓` good · `✗` broken (fails the run) · `⚠` optional/degraded · `–` informational state. Every `✗`/`⚠` is followed by a `→ <fix>` line. It **exits non-zero** when a *required* check fails (bash, python3, node ≥22, chrome, curl, and — when the launchd daemon is configured — the job load + its resolved node/python3). Live-service state (server/CDP port down, bridge not running, proxy unreachable, api key unset) is informational and never fails the run, since "down before `glimpse open`" is normal.
- **The classic silent failure is launchd's minimal PATH.** The always-on menu-bar daemon runs `/bin/bash -lc 'source ~/.config/secrets.env; exec glimpse menubar'`; launchd's login shell misses the fnm/nvm setup that only zsh sources, so `node` (and sometimes `python3`) can't be found and CDP calls die quietly. `_ensure_node` prepends `_node_candidates` (stable install dirs) as a workaround; `cmd_doctor`'s `_launchd_resolve` reproduces that exact env to report whether the daemon would find them, and reuses the same `_node_candidates` list so the check never drifts. Pin with `GLIMPSE_NODE` in `~/.config/secrets.env`.
- **Scope discipline:** only `install.sh` and `cmd_doctor` (plus shared helpers `_node_candidates` / `_launchd_resolve`) own this behavior. Don't add network calls beyond the dependency version probes already present, and keep loopback/secret-scrub posture intact.

## Auto-audit on publish + the layout gate

- **`glimpse publish` auto-audits the real render and warns by default.** After the artifact is written + fed, `_publish_autoaudit` drives the existing in-browser auditor (`canvas/glimpse-audit.js`) via the shared `_audit_capture` and surfaces a one-line summary like `⚠ glimpse: 2 layout issues in <slug> — content overflow in div.foo (+40px); … — run: glimpse audit <slug>`. The warning goes to **stderr** so stdout stays the published URL; a **clean artifact prints nothing** (quiet-by-default). It never reimplements audit rules — severity/finding vocabulary stays in `glimpse-audit.js`.
- **Warn-only stays fast; the gate is opt-in.** Without a gate, the auto-audit only runs when the canvas is already live (`_canvas_live`: both the static server and a debuggable Chrome answer on the loopback ports) — a scripted/headless publish stays a pure file write and never launches Chrome. `--gate` (or `GLIMPSE_AUDIT_GATE=1`) turns an **error-severity** finding into a non-zero exit so an agent/CI can enforce layout quality; because the audit needs a real render, the gate brings the canvas up itself. The publish is **flagged, not rolled back** — the rendered artifact is left in place (the auditor needs it on disk) and the message says so. `--no-audit` (or `GLIMPSE_AUDIT=0`) skips the whole step.
- **One capture, one renderer — no drift.** `_audit_capture <slug>` is the single CDP navigate+reload+poll path; both the standalone `audit` verb and auto-audit consume its raw `window.__glimpse_audit` JSON. `lib/glimpse_audit_report.py` is the single output renderer (`MODE=full` reproduces `glimpse audit`'s detailed report + compact machine JSON; `MODE=brief` is the publish one-liner) and the single source of the gate exit code (2 iff any error-severity finding). Keep formatting/counting there; keep detection in `glimpse-audit.js`.

## `bin/glimpse` is a pure bash dispatcher — no polyglot heredocs

The CLI verbs live in `bin/glimpse`, but the Python and JavaScript they used to
embed as `<<'PY'` / `<<'JS'` heredocs now live in real files under `lib/`. The
dispatcher shells out to them; **do not reintroduce polyglot heredoc bodies in
`bin/glimpse`.** Small inline one-liners (`python3 -c`, `python3 --version`, and
the per-verb JS bodies passed to `run_cdp`) are fine.

### `lib/` layout

| File | Invoked by | Interface |
|------|-----------|-----------|
| `glimpse_feed.py` | `feed_upsert`, `_feed_op`, `cmd_list` | `python3 … {upsert\|op\|list}`; args via env (`SLUG TITLE TS PENDING NOANNOTATE KIND`, `ACTION SLUGS KEEP SLUG`, `GLIMPSE_DIR`) |
| `glimpse_threads.py` | `_thread_op`, `cmd_threads`, `cmd__pending` | `python3 … {op\|list\|pending}`; env `ACTION SLUG QUOTE TEXT ANCHOR CLIENT_TURN_ID ARTIFACT_TS TO TS SECRET_PATTERN GLIMPSE_DIR` |
| `glimpse_server.py` | `cmd_serve` | `python3 … <port> <root>` (argv) — loopback-bound quiet static server |
| `glimpse_chrome_profile.py` | `cmd_chrome` | `python3 … <profile-dir>` (argv) + env `GLIMPSE_PROFILE_LABEL`; best-effort |
| `glimpse_explain.py` | `cmd_explain` | `python3 … wrap <title>` (pre-existing) |
| `glimpse_export.py` | `_inline_artifact` (→ `cmd_export`, `cmd_share`) | `python3 … <src.html>` (argv) + env `SECRET_PATTERN` — offline inliner; HTML→stdout, warnings→stderr |
| `glimpse_share.py` | `cmd_share` | `python3 …`; HTML on **stdin**; env `GLIMPSE_PASSWORD GLIMPSE_HTML_APP_BASE GLIMPSE_HTML_APP_TOKEN` — POSTs to ht-ml.app, prints `{url,site_id,update_key,private}` JSON |
| `glimpse_audit_report.py` | `cmd_audit`, `_publish_autoaudit` | `python3 …` reads audit JSON on stdin; env `MODE`(full\|brief) `SLUG`; exits 2 iff an error-severity finding |
| `glimpse-cdp.mjs` | `run_cdp`, `cmd_bridge` | shared CDP client (`cdpConnect`, `fail`) — **spliced** ahead of the body via `node --input-type=module -e "$(cat …)"` |
| `glimpse-bridge.mjs` | `cmd_bridge` | the highlight-chat bridge loop — spliced after `glimpse-cdp.mjs`; env `GLIMPSE_BIN WAIT PORT GLIMPSE_DIR` (+ daemon `GLIMPSE_ANSWER …`) |
| `glimpse-poll.mjs` | `cmd_poll` | the single-shot blocking feedback drainer — spliced after `glimpse-cdp.mjs`; env `GLIMPSE_BIN PORT CDP_PORT GLIMPSE_DIR POLL_JSON POLL_TIMEOUT_MS POLL_INTERVAL_MS` |
| `glimpse-snapshot.mjs` | `cmd_snapshot` | accessibility-tree text snapshot body — read by `cmd_snapshot` and passed to `run_cdp` (not spliced standalone); env `URL SECRET_PATTERN` |

`glimpse-cdp.mjs` / `glimpse-bridge.mjs` are the verbatim former `CDP_HELPER` /
`BRIDGE_JS` heredoc bodies with **no `import`/`export`** — they are concatenated
by the shell (`… -e "$(cat cdp)"$'\n'"$(cat bridge)"`), exactly as the heredocs
were, so composition is byte-identical. Because they run as one spliced module,
the bridge can't be `import`ed cleanly; `tests/test_bridge_origin.mjs` therefore
regex-extracts `isCanvasOrigin`/`LOOPBACK_HOSTS` out of `lib/glimpse-bridge.mjs`.

### Path resolution & shipping

`_lib_file <name>` resolves a lib file in this order: this checkout's `lib/`,
then `$GLIMPSE_DIR/<name>`, then `~/.glimpse/<name>` — so it works from any cwd
and after install (where `$SELF_DIR/../lib` does not exist). Any new lib file
must be added to **all three** of `install.sh` (the copy loop into
`$GLIMPSE_DIR`), `scripts/dev-link.sh` (the `ASSETS` array), and its `_lib_file`
call in `bin/glimpse`, or an installed `glimpse` won't find it.

Env/arg passing into the extracted scripts is unchanged: inline `VAR=… python3
"$f" …` exports to the (external) `python3` exactly as the old inline heredoc did.

## Portable output: `export` (offline) & `share` (remote)

Two verbs turn a *published* artifact into a portable copy. Both reuse one
offline inliner, `lib/glimpse_export.py`, via the `_inline_artifact` helper.

- **`glimpse export <slug> [--out <path>]`** writes a single self-contained HTML
  file. All **local** assets (relative `href`/`src` stylesheets, scripts, images,
  fonts, and `url()`/`@import` inside CSS) are inlined as `<style>`/`<script>` or
  `data:` URIs; **remote** refs (`https://`, `//cdn…`, `data:`, `#`) are left as
  network links on purpose — a Mermaid/Tailwind CDN link keeps loading from the
  net. Root-absolute (`/foo`) refs can't be resolved without a server root, so
  they're left as-is with a warning. Fully offline; no network, no node.
  - **Default output is the *current directory*** (`./<slug>.export.html`), not
    "next to the source": glimpse's source lives in the hidden `$GLIMPSE_DIR/
    artifacts/`, so "next to source" would bury the file. `--out` overrides. (This
    is where it deliberately differs from `lavish-axi export`, whose source is a
    user-visible `.lavish/` file.)
- **`glimpse share <slug> [--public] [--password <pw>]`** builds the same inlined
  bundle and uploads it to **ht-ml.app** (`lib/glimpse_share.py`, stdlib urllib),
  printing the visitable URL + the secret `update_key`.
  - **PRIVATE by default** — a firm product decision that deliberately **diverges
    from lavish's public-by-default**. With no flag, the page is
    password-protected: `--password <pw>` sets it, otherwise a strong random one
    is minted (`secrets.token_urlsafe`) and printed. `--public` opts into a fully
    open page. `--public` + `--password` is rejected.
  - Prints a concise **"this leaves your machine to a third-party public host"
    notice to stderr before every upload** (glimpse otherwise markets itself as
    local & serverless, so the egress must be unmistakable).

**Naming resolution (the collision):** glimpse already had `publish`/`cmd_publish`
= publish to the *local* canvas. The remote share is a **separate verb, `share`**
(never folded into `publish`), so the local verb is untouched and the name matches
`lavish-axi share`. `publish` stays local-only.

**Security posture (unchanged, enforced by the inliner):** file reads are
**confined to the artifact's own directory** — a `../` or symlink escape is
refused and left as a link (`outside-root` warning), so export never reaches into
the wider filesystem. The final bundle is **secret-scrubbed against
`SECRET_PATTERN`** (shared with the thread guard) before it is written or
uploaded, so a secret that slipped into an artifact or a local asset is never
baked into a portable file that leaves the machine. `share`'s only network egress
is ht-ml.app, and its endpoint host is **anchored** (`host == "ht-ml.app" ||
host.endswith(".ht-ml.app")`) — a `GLIMPSE_HTML_APP_BASE` override can't point it
elsewhere. There is no delete endpoint on ht-ml.app; a shared page persists.

## Highlight-chat feedback: `poll` (one blocking call) vs `bridge` (a stream)

There are two ways to receive human highlights/questions, over the **same**
files-on-disk, pull-only machinery — the durable queue is the set of `pending`
user turns in `threads/<slug>.json`; nothing is ever an inbound network endpoint.

- **`glimpse poll` is the agent interface**: ONE blocking call the agent parks on.
  It blocks until there is undelivered feedback, prints it, and returns. This is
  the analogue of `lavish-axi poll`, and it supersedes the old "run `glimpse bridge`
  under a Monitor" pattern for an in-the-loop agent. Usage pattern: call `glimpse
  poll` → read the record(s) → `glimpse reply <slug> "…" --to <id>` → call `glimpse
  poll` again. On timeout it exits **3** with a marker (re-poll); on delivery it
  exits **0**.
- **`glimpse bridge` stays as-is** — a long-lived JSON-line stream. The **daemon**
  (`cmd_daemon`) still layers auto-answer on top of the bridge, and the menu-bar app
  drives the daemon. Don't run `poll` and `bridge`/`daemon` against the same canvas
  at once: both would drain and both would emit (persist is idempotent, so the store
  stays correct, but you'd get two answerers). Poll = human-agent-in-the-loop;
  daemon = always-on auto-answer.

How poll reuses the machinery (`lib/glimpse-poll.mjs`, spliced after the CDP helper
exactly like the bridge): each tick it (a) drains every canvas tab's
`window.__glimpse_outbox` into the store via `glimpse __thread-add-user` (idempotent
by `clientTurnId`, so it coexists with a running bridge), then (b) reads
`glimpse __pending` and emits the pending turns it hasn't delivered yet. Dedup is a
persisted delivered set in **`.poll.state`** — it does **NOT** mutate turn `status`,
so the canvas keeps showing "awaiting answer" until you `reply` (the front-end reads
`status`). If Chrome is down it degrades to disk-only (still blocks on the queue).
Because turns are secret-scrubbed at persist time and poll only emits fields from
that scrubbed store, poll can't leak a scrubbed secret. Its canvas-origin predicate
is kept **byte-identical** to the bridge's; `tests/test_poll.mjs` extracts both and
asserts they match, so the loopback allowlist can't drift.

### Output format (token-efficient, documented, `--json` escape hatch)

`glimpse poll` default output is a compact, TOON-like line format: a self-describing
header comment declares the field order once, then one **TAB-separated** record per
feedback item — far cheaper for an agent to parse than repeated-key JSON.

```
#glimpse-poll v1 fields=kind,thread,id,ts,anchor,quote,text
question<TAB>arch<TAB>1751-2-ab<TAB>1751<TAB>text:1<TAB>the cache<TAB>why write-through?
```

- Fields containing tab/newline/CR/backslash are escaped (`\t \n \r \\`) so a record
  is always exactly one line. `anchor` collapses to a compact token:
  `text:<occurrence>` (highlight) · `node:<id>` (explainer node) · `-` (none).
- Lines beginning with `#` are metadata/markers (header, and `#glimpse-poll v1
  timeout=Ns` on timeout) — a parser skips them.
- `--json` emits one JSON object `{"type":"poll","count":N,"ts":…,"items":[…]}`
  (each item keeps the **full** anchor object); on timeout it adds `"timeout":N`.
- `glimpse list --json` (feed) and `glimpse read` (already JSON) give agents the same
  machine-readable escape hatch; `glimpse __pending` now includes each turn's `ts`.

The pure format helpers live in a `// >>> glimpse-poll format helpers … // <<<`
block in `lib/glimpse-poll.mjs` (extracted+eval'd by `tests/test_poll.mjs`). A sibling
task may fold the Python ops into Node; poll's queue read (`__pending`) and persist
(`__thread-add-user`) go through the existing flocked writer, so poll's own logic
(drain loop, delivered cursor, formatting) stays cleanly separable from that move.

## `glimpse snapshot` — agent-facing a11y-tree capture

`glimpse snapshot [#slug|url]` is the readable, token-efficient sibling of `shot`
(pixels) and `read` (raw innerText): it prints the page's **accessibility tree** as
an indented role/name outline, for an AI agent to reason about structure without a
screenshot. The format mirrors `chrome-devtools-axi snapshot` so agents used to that
tool feel at home:

```
page:
  title: "Snapshot Demo"
  url: "http://127.0.0.1:4321/artifacts/snap-demo.html"
  nodes: 20
snapshot:
uid=s0 RootWebArea "Snapshot Demo"
  uid=s1 heading "Glimpse Snapshot Demo" level="1"
  uid=s7 navigation "Main"
    uid=s8 link "Example link"
  uid=s13 textbox "Search" value="hello world"
  uid=s15 checkbox "Subscribe" checked="true"
```

- One line per node: `uid=s<N> <role> "<name>"` plus state attrs (`level`,
  `checked`, `expanded`, `value`, …). `uid`s are `s0..sN` in document order —
  stable within a single snapshot. Structural noise (`generic`/`presentation`/
  `InlineTextBox`) and `ignored` nodes are collapsed; their meaningful descendants
  reparent up, so the tree stays compact.
- **Read-only.** It navigates only when handed a target (like `read`), never mutates
  the page. Built on the shared CDP client (`run_cdp` → `lib/glimpse-snapshot.mjs`) —
  no second browser channel. Names/values are secret-scrubbed against `SECRET_PATTERN`
  (same posture as thread turns) so a captured field can't leak a token.
- **Sharp edge — `#slug` resolves to the served artifact FILE, not the canvas hash
  route.** The canvas renders artifacts inside a `sandbox="allow-scripts"` iframe with
  an **opaque origin** (no `allow-same-origin`). CDP's frame-scoped a11y calls
  (`Accessibility.getFullAXTree({frameId})`, `Page.getFrameTree`) can't reach into
  that isolated frame — from the shell it shows up as a bare `Iframe` leaf. So
  `cmd_snapshot` maps `#slug → http://127.0.0.1:$PORT/artifacts/<slug>.html` and
  snapshots the pristine file as a top-level document, yielding the artifact's full,
  clean tree. The body still grafts *ordinary* same-origin child frames (which DO
  appear in `Page.getFrameTree`) under their owning `Iframe` node via
  `DOM.getFrameOwner`, so a plain multi-frame URL still descends correctly.

## Tests

- `uv run --with pytest pytest tests/` — Python units (incl. `test_glimpse_export.py`, the inliner)
- `node --test tests/*.mjs tests/*.cjs` — renderer/bridge/poll units (no deps); includes
  `test_snapshot_render.mjs`, which drives the real `lib/glimpse-snapshot.mjs` body
  with a stubbed CDP channel (no browser) to cover tree-building, node collapsing,
  iframe grafting, and secret scrubbing, and `test_poll.mjs` (format helpers + origin
  anti-drift). Note `tests/cdp_assert_render.mjs` is a live-CDP helper caught by the
  glob; it only passes with a running `glimpse open` and otherwise fails (not a unit
  regression).
- `bash tests/test_explain_cli.sh`, `bash tests/test_node_anchor.sh`,
  `bash tests/test_export_cli.sh`, `bash tests/test_publish_audit.sh` — CLI smoke
  (the export test is offline; it never uploads. the publish-audit test covers the
  auto-audit flag/env parsing + the "not watching → skip" path, no browser)
- `bash tests/test_poll_cli.sh` — `glimpse poll` end-to-end (disk-only: blocks→delivers,
  dedup/nothing-dropped, `--json`, timeout exit 3)
- `GLIMPSE_RUNTIME_TESTS=1 bash tests/test_*_cdp.sh` / `test_node_roundtrip.sh` —
  live-CDP, opt-in (need a running `glimpse open`). `test_publish_audit_cdp.sh`
  is the end-to-end auto-audit warn/gate check against a real render.
