# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Canvas authoring playbooks

When authoring an artifact to publish to the Glimpse canvas, agents follow a
structured playbook set — the friendliness/quality layer, analogous to the
review-artifact playbooks in sibling tooling.

- **Where they live:** `skills/canvas/playbooks/`. `README.md` is the router and
  holds the shared **design direction**, **light/dark theming**, and
  **portability/overflow** rules. One focused file per playbook: `diagram`,
  `table`, `plan`, `code`, `input`, `comparison`, `slides` — each a crisp
  *use-when* + *recipe* + copy-adaptable *snippet*. `base.html` is the
  copy-me starter that encodes the theme + toggle + overflow scaffolding.
- **Discovery:** `skills/canvas/SKILL.md` has a "Playbooks" section linking the
  set; the `explain` skill remains the path for dedicated code walkthroughs.
- **Worked examples:** `examples/playbooks/*.html` — one self-contained artifact
  per playbook. Light+dark screenshots at `examples/screenshots/<name>-{light,dark}.png`.

### Design bar for playbook artifacts (must hold)
1. Modern, editorial developer-tool look; indigo accent; **monospace eyebrow**
   labels are the signature. Match the existing `examples/` house style.
2. **First-class light AND dark mode.** Tokens on `:root` (light), overridden
   under both `@media (prefers-color-scheme: dark)` and `:root[data-theme="dark"]`
   so an explicit toggle beats the OS. All theme changes route through one
   `window.__applyTheme(mode)` that sets the attribute AND repaints the toggle
   label/aria, so state can never drift (the pill label names the mode you switch
   TO). Mermaid bakes its theme at `initialize()` — re-init + re-run on change via
   the `window.__onThemeChange` hook, using custom `theme:'base'` `themeVariables`
   matched to the palette (not stock `neutral`/`dark`, which read as generic).
3. **No horizontal overflow at any nesting level:** flex/grid children need
   `min-width:0`, tracks use `minmax(min(240px,100%),1fr)`; long tokens/URLs/paths
   `overflow-wrap:anywhere`; tables in `.table-wrap{overflow-x:auto}`;
   `pre{overflow:auto;max-width:100%}`.
4. **Portable:** self-contained, inline CSS/JS, no build step; opens identically
   from disk. CDN (Mermaid) is fine — the canvas Chrome has internet.

### Verifying artifact rendering
Local files render/screenshot via `chrome-devtools-axi`: `newpage file://…`,
`resize 1440 900`, then `selectpage <id>` (resize deselects the page), set the
theme with `eval "() => window.__applyTheme('dark')"` (repaints label + re-themes
Mermaid), `screenshot <abspath>` (use an **absolute** path — relative paths write
to the bridge's cwd, not yours). `glimpse shot` is the alternative when the canvas
is up.

**Scope guard:** playbooks are authoring guidance only. Do not encode runtime
behavior — the CLI verbs live in `bin/glimpse` and must not be invented in docs.
## Install & doctor conventions

- **`install.sh` is one idempotent command.** It runs a preflight (node ≥22, Chrome; python3 is an optional macOS-only hint) printing `✓`/`✗`/`⚠` with a copy-pasteable, OS-aware fix per line, then installs the CLI + canvas assets regardless. Node ≥22 is the **only required** runtime: if it is missing the installer still installs the CLI (so `glimpse doctor` can re-diagnose) but exits non-zero. Chrome is a **warning only** — it is driven at runtime and doctor re-checks it, so a missing browser never blocks the install. python3 is **optional** (only the macOS menu-bar app uses it) and never fails the install. Re-running is always safe.
- **`glimpse doctor` (`cmd_doctor`) is loud and scriptable.** One line per check with a marker: `✓` good · `✗` broken (fails the run) · `⚠` optional/degraded · `–` informational state. Every `✗`/`⚠` is followed by a `→ <fix>` line. It **exits non-zero** when a *required* check fails (bash, node ≥22, chrome, curl, and — when the launchd daemon is configured — the job load + its resolved node). python3 is not a required check; the launchd `python3` resolution is reported as an optional `⚠` (menu-bar app only). Live-service state (server/CDP port down, bridge not running, proxy unreachable, api key unset) is informational and never fails the run, since "down before `glimpse open`" is normal.
- **The classic silent failure is launchd's minimal PATH.** The always-on menu-bar daemon runs `/bin/bash -lc 'source ~/.config/secrets.env; exec glimpse menubar'`; launchd's login shell misses the fnm/nvm setup that only zsh sources, so `node` (and, for the menu-bar app, `python3`) can't be found and CDP calls die quietly. `_ensure_node` prepends `_node_candidates` (stable install dirs) as a workaround; `cmd_doctor`'s `_launchd_resolve` reproduces that exact env to report whether the daemon would find them, and reuses the same `_node_candidates` list so the check never drifts. Pin with `GLIMPSE_NODE` in `~/.config/secrets.env`.
- **Scope discipline:** only `install.sh` and `cmd_doctor` (plus shared helpers `_node_candidates` / `_launchd_resolve`) own this behavior. Don't add network calls beyond the dependency version probes already present, and keep loopback/secret-scrub posture intact.

## Auto-audit on publish + the layout gate

- **`glimpse publish` auto-audits the real render and warns by default.** After the artifact is written + fed, `_publish_autoaudit` drives the existing in-browser auditor (`canvas/glimpse-audit.js`) via the shared `_audit_capture` and surfaces a one-line summary like `⚠ glimpse: 2 layout issues in <slug> — content overflow in div.foo (+40px); … — run: glimpse audit <slug>`. The warning goes to **stderr** so stdout stays the published URL; a **clean artifact prints nothing** (quiet-by-default). It never reimplements audit rules — severity/finding vocabulary stays in `glimpse-audit.js`.
- **Warn-only stays fast; the gate is opt-in.** Without a gate, the auto-audit only runs when the canvas is already live (`_canvas_live`: both the static server and a debuggable Chrome answer on the loopback ports) — a scripted/headless publish stays a pure file write and never launches Chrome. `--gate` (or `GLIMPSE_AUDIT_GATE=1`) turns an **error-severity** finding into a non-zero exit so an agent/CI can enforce layout quality; because the audit needs a real render, the gate brings the canvas up itself. The publish is **flagged, not rolled back** — the rendered artifact is left in place (the auditor needs it on disk) and the message says so. `--no-audit` (or `GLIMPSE_AUDIT=0`) skips the whole step.
- **One capture, one renderer — no drift.** `_audit_capture <slug>` is the single CDP navigate+reload+poll path; both the standalone `audit` verb and auto-audit consume its raw `window.__glimpse_audit` JSON. `lib/glimpse-audit-report.mjs` is the single output renderer (`MODE=full` reproduces `glimpse audit`'s detailed report + compact machine JSON; `MODE=brief` is the publish one-liner) and the single source of the gate exit code (2 iff any error-severity finding). Keep formatting/counting there; keep detection in `glimpse-audit.js`.

## `bin/glimpse` is a pure bash dispatcher — no polyglot heredocs

The CLI verbs live in `bin/glimpse`, but the JavaScript they used to embed as
`<<'JS'` heredocs (and the ops that used to be `<<'PY'` Python) now live in real
`.mjs` files under `lib/`. glimpse runs on **Node + Chrome only** — there is no
Python in the runtime path (only the optional macOS menu-bar app, `app/
glimpse_menubar.py`, still uses Python/rumps). The dispatcher shells out to the lib
files with `node`; **do not reintroduce polyglot heredoc bodies in `bin/glimpse`.**
Small inline one-liners (`node -e`, and the per-verb JS bodies passed to `run_cdp`)
are fine.

### `lib/` layout

Every lib file is Node (`.mjs`, Node stdlib only). The ops modules expose their
functions as ESM `export`s (so `node:test` can unit-test them) behind an
`import.meta`-guarded CLI `main`.

| File | Invoked by | Interface |
|------|-----------|-----------|
| `glimpse-feed.mjs` | `feed_upsert`, `_feed_op`, `cmd_list` | `node … {upsert\|op\|list}`; args via env (`SLUG TITLE TS PENDING NOANNOTATE KIND`, `ACTION SLUGS KEEP SLUG`, `GLIMPSE_DIR`) |
| `glimpse-threads.mjs` | `_thread_op`, `cmd_threads`, `cmd__pending` | `node … {op\|list\|pending}`; env `ACTION SLUG QUOTE TEXT ANCHOR CLIENT_TURN_ID ARTIFACT_TS TO TS SECRET_PATTERN GLIMPSE_DIR` |
| `glimpse-store.mjs` | imported by `glimpse-feed.mjs` + `glimpse-threads.mjs` | shared file-store helpers (`withLock`, `readJson`, `writeJsonAtomic`) — O_EXCL lock file + stale-pid takeover replacing the Python `flock`. Not spawned; must ship next to feed/threads so their relative `import` resolves |
| `glimpse-server.mjs` | `cmd_serve` | `node … <port> <root>` (argv) — loopback-bound quiet static server + `/__glimpse/events` SSE |
| `glimpse-chrome-profile.mjs` | `cmd_chrome` | `node … <profile-dir>` (argv) + env `GLIMPSE_PROFILE_LABEL`; best-effort |
| `glimpse-explain.mjs` | `cmd_explain` | `node … {validate\|wrap <title>}` — exports `validate`/`wrapArtifact`/`truncateSnippet`/`SpecError` |
| `glimpse-ask.mjs` | `cmd_ask` (`--form` only) | `node … {validate\|wrap <title>}` — reads a decision-form spec on stdin, renders native accessible controls (see "`glimpse ask --form`" below) |
| `glimpse-export.mjs` | `_inline_artifact` (→ `cmd_export`, `cmd_share`) | `node … <src.html>` (argv) + env `SECRET_PATTERN` — offline inliner; HTML→stdout, warnings→stderr; exports `transform`/`scrubSecrets` |
| `glimpse-share.mjs` | `cmd_share` | `node …`; HTML on **stdin**; env `GLIMPSE_PASSWORD GLIMPSE_HTML_APP_BASE GLIMPSE_HTML_APP_TOKEN` — POSTs to ht-ml.app, prints `{url,site_id,update_key,private}` JSON |
| `glimpse-audit-report.mjs` | `cmd_audit`, `_publish_autoaudit` | `node …` reads audit JSON on stdin; env `MODE`(full\|brief) `SLUG`; exits 2 iff an error-severity finding |
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

Env/arg passing into the extracted scripts is unchanged: inline `VAR=… node
"$f" …` exports to the (external) `node` exactly as the old inline heredoc did.

## `glimpse ask --form` — declarative decision forms

`glimpse ask <slug> <title> [spec.json] --form` renders a small JSON spec into
an artifact of **native, accessible controls** (radio group / checkbox group /
select / text / textarea), blocks until the human submits, and prints the
structured choice as `{"slug","value"}` — the author writes no HTML and wires no
return plumbing. Without `--form`, `ask` is unchanged (the file is raw HTML).

The spec is validated + rendered by `lib/glimpse-ask.mjs` (mirrors
`glimpse-explain.mjs`: exit `2` on any spec-content error, publishing nothing;
`1` stays reserved for the verb's own failures). Shape:

```jsonc
{
  "prompt": "Approve the migration?",     // optional; in-page <h1> (defaults to <title>)
  "intro":  "One line of context.",       // optional supporting paragraph
  "submitLabel": "Send decision",         // optional; button text (default "Submit")
  "fields": [                             // required, non-empty (≤50)
    { "type": "radio",    "name": "decision", "label": "Decision", "required": true,
      "options": [ {"value":"approve","label":"Approve","selected":true},
                   {"value":"reject","label":"Reject"} ] },   // → value string (null if none)
    { "type": "checkbox", "name": "flags", "label": "Options", "help": "pick any",
      "options": [ {"value":"backup","label":"Snapshot first"} ] },  // → array of values
    { "type": "select",   "name": "batch", "required": true,
      "options": [ {"value":"500"}, {"value":"1000","label":"1,000"} ] },  // → value string
    { "type": "text",     "name": "note", "placeholder": "e.g. after 6pm" }, // → string
    { "type": "textarea", "name": "details" }                               // → string
  ]
}
```

`name` (per field) is the key in the returned `value` object and must match
`[A-Za-z0-9_-]{1,64}`, unique across fields. `options` is required (and
forbidden on text/textarea) for the three choice types; option `value`s must be
unique non-empty strings. See `examples/ask-form.json`.

**Sharp edges baked into the renderer — do not regress:**

- **The canvas iframe is `sandbox="allow-scripts"` with NO `allow-forms`,** so a
  real `<form>` submission (and the `submit` event) is *blocked by the sandbox*.
  The renderer therefore drives off the submit **button's `click`** (a
  `type="button"`, never a real submit) → `glimpseSubmit()` → the existing
  `glimpseRespond()` postMessage. Never switch it back to a form-`submit`
  listener or `<button type="submit">` — it will silently never fire in-canvas.
- **Custom radios/checkboxes** use `appearance:none` + CSS-drawn indicators so
  they read as **hollow when unselected / filled when selected in BOTH light and
  dark mode** (native radios render as filled black dots in light mode — the
  input-playbook design-review pitfall this exists to avoid). Both themes are
  driven by `prefers-color-scheme` CSS vars.
- **Validation:** native `required` (radio / select / text / textarea) is
  enforced via `form.reportValidity()` inside the click handler (works
  in-sandbox — it doesn't submit); "pick at least one" for a *required checkbox
  group* can't be expressed natively, so it uses a `data-min="1"` attribute on
  the `<fieldset>` checked in JS.
- **No spec data reaches JS/CSS** — the collector reads live DOM state and the
  script is an injection-free constant; every spec string is HTML-escaped into
  markup. Return rides the SAME `glimpse:response` channel `cmd_ask` already
  polls; no second channel.

## Per-artifact keying — several artifacts (and agents) can be active at once

Every feedback / response / thread stream is **keyed per artifact by slug**, end to
end, so highlights or answers on artifact A never leak into B's stream and an agent can
address each independently. There is no global "the active artifact" state that carries
feedback — the slug is the key at every hop:

- **Storage (source of truth):** `threads/<slug>.json` — one exclusive-locked,
  atomic read-modify-write per artifact (`glimpse-threads.mjs`). `feed.json` holds one
  entry per slug. Two agents can `publish` / `reply` / `thread` different slugs
  concurrently without contention (per-slug `flock`); a turn id from A's thread cannot
  be answered inside B's (`add_agent` rejects a foreign `TO`).
- **Bridge (`glimpse-bridge.mjs`):** keeps a live CDP connection to **every** open
  canvas tab and routes each drained outbox message by its own `m.slug` — never by
  which tab is focused. Dedup (`seen`) and emit (`emitted`) sets are keyed by globally
  unique message / turn ids, so multiple tabs and multiple artifacts share them safely.
- **Canvas shell (`canvas/index.html`):** browser→agent buffers are keyed off the
  **iframe's own slug** (`f.dataset.slug`, stamped in `show()`), not the mutable
  `current`. `window.__glimpse_responses[slug]` (read by `glimpse ask`), each pushed
  `__glimpse_outbox` entry's `slug`, and `window.__glimpse_audit[slug]` (read by
  `glimpse audit`) are all per-slug. `__glimpse_audit` is a **per-slug map** (not one
  latest-buffer): viewing a second artifact no longer wipes the first's audit; `show()`
  clears only the shown slug's stale entry so it re-captures fresh.

The dashboard still renders **one artifact at a time** (the common single-artifact
experience is unchanged) — the keying is what lets more than one be live without
cross-talk. **When you touch any browser→agent buffer, key it by the sending iframe's
slug, never by `current`.** Multi-tab, multiple-agent audit-window selection in
`cmd_ask`/`cmd_audit` (which grab *a* canvas tab) is out of scope here; the buffers they
read are already per-slug.

## Portable output: `export` (offline) & `share` (remote)

Two verbs turn a *published* artifact into a portable copy. Both reuse one
offline inliner, `lib/glimpse-export.mjs`, via the `_inline_artifact` helper.

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
  bundle and uploads it to **ht-ml.app** (`lib/glimpse-share.mjs`, Node stdlib),
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
block in `lib/glimpse-poll.mjs` (extracted+eval'd by `tests/test_poll.mjs`). The ops
are now all Node; poll's queue read (`__pending`) and persist (`__thread-add-user`) go
through the shared Node file-store writer (`glimpse-store.mjs`), so poll's own logic
(drain loop, delivered cursor, formatting) stays cleanly separable from that store.

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

## Canvas freshness is push (SSE), not polling

The canvas no longer busy-polls for new content. The static server
(`lib/glimpse-server.mjs`) is the push side; `canvas/index.html` is the consumer.

- **Server side — one watcher, an SSE endpoint.** A single daemon thread stats
  `feed.json` (mtime+size) and `threads/*.json` (max mtime + file count) every
  `POLL_S` (0.4s) and bumps a per-stream version (`feed`/`thread`) under a
  `threading.Condition` when either fingerprint changes. `GET /__glimpse/events`
  is a `text/event-stream` handler (added via a `do_GET` override on the existing
  `Quiet` handler — all other paths still fall through to `SimpleHTTPRequestHandler`):
  it blocks on the condition and writes `event: feed` / `event: thread` the instant
  a version advances. This moves the freshness cost from *N browser HTTP+JSON polls*
  to *one process doing `stat()`* — the reason `.server.log` used to balloon is gone.
  The event body is a bare `data: 1` signal — **never file content** — so it can leak
  nothing the served files don't already expose. Loopback bind is unchanged; stdlib
  only (no framework). On connect the handler re-emits an initial `feed`+`thread`
  so a fresh **or reconnected** client re-syncs, and sends a `: ping` comment every
  `HEARTBEAT_S` (15s) to keep the socket open / surface a drop.
- **Canvas side — `connectEvents()` replaces the three timers.** An `EventSource`
  to `/__glimpse/events` calls `poll()` on a `feed` event and `pollThread()` on a
  `thread` event; the socket says *when*, `poll`/`pollThread` still `fetch` the actual
  content (so the per-slug thread routing and feed signature logic are untouched).
  The old `setInterval(poll,1200)` / `setInterval(pollThread,1000)` are **removed**.
  Recovery is layered: `EventSource` auto-reconnects on the server's `retry:` hint
  (a restart re-syncs via the initial events), and a **slow 20s fallback heartbeat**
  (`poll()`+`pollThread()`) re-syncs if the stream ever wedges silently — that 20s
  timer is the only steady-state timer that touches the network, and only as a safety
  net. `updateLiveness` **stays on its 1.5s timer**: it reflects the bridge's CDP-stamped
  `window.__glimpse_bridge_live` (there is no server file to push for it) and does **no**
  network I/O, so it is not the busy-poll the push channel removed.
- **Pin reconcile.** `reconcilePins()` used to ride the 1.2s feed poll. The
  daemon-confirm path now rides the SSE `feed` event (daemon rewrites `feed.json` →
  push → `poll` → reconcile). A daemon-**down** revert has no feed change to ride, so
  `ensureReconcile()` runs a short local ticker (cached feed, no fetch) that lives
  **only** while `pendingPins` is non-empty, preserving the 3.5s "pin didn't stick"
  revert without steady-state polling.
- **Scope for the Node-consolidation task (J):** the push mechanism is confined to
  `glimpse-server.mjs` (server) + `connectEvents()` (canvas). The server is
  Node means re-implementing the same watcher→SSE contract (`/__glimpse/events`,
  `event: feed`/`event: thread`, initial re-emit, `retry:`+heartbeat); the canvas
  consumer does not change.

## Tests

- `node --test tests/test_*.cjs tests/test_*.mjs` — the whole unit suite (no deps, no
  browser). Includes the ported lib-ops tests: `test_glimpse_export.mjs` (the inliner),
  `test_glimpse_threads_multi.mjs` (two artifacts keep separate threads / pending /
  replies, and clearing one leaves the other), `test_glimpse_explain.mjs`,
  `test_glimpse_ask.mjs`, and `test_audit_report.mjs` — each drives the real `.mjs`
  module's exported functions. Also the pure-logic renderer/bridge/poll/snapshot units:
  `test_snapshot_render.mjs` drives the real `lib/glimpse-snapshot.mjs` body with a
  stubbed CDP channel (no browser) to cover tree-building, node collapsing, iframe
  grafting, and secret scrubbing, and `test_poll.mjs` (format helpers + origin
  anti-drift). `test_glimpse_server_sse.mjs` starts the real Node server on a loopback
  port and asserts `/__glimpse/events` pushes a `feed` event on a `feed.json` change and
  a `thread` event on a `threads/*.json` change (carrying only the signal — no file
  content), but is **runtime-gated behind `GLIMPSE_RUNTIME_TESTS`** (like the live-CDP
  tests) and skipped by default: the hosted macOS runner can't complete the loopback
  server↔client setup ("server did not come up"), a runner-environment limitation — not
  a product bug (the feature is verified on ubuntu + locally). Run it with
  `GLIMPSE_RUNTIME_TESTS=1 node --test tests/test_glimpse_server_sse.mjs`. Note
  `tests/cdp_assert_render.mjs` is a live-CDP helper caught by the glob; it only passes
  with a running `glimpse open` and otherwise fails (not a unit regression).
- `bash tests/test_explain_cli.sh`, `bash tests/test_node_anchor.sh`,
  `bash tests/test_export_cli.sh`, `bash tests/test_publish_audit.sh` — CLI smoke
  (the export test is offline; it never uploads. the publish-audit test covers the
  auto-audit flag/env parsing + the "not watching → skip" path, no browser)
- `bash tests/test_poll_cli.sh` — `glimpse poll` end-to-end (disk-only: blocks→delivers,
  dedup/nothing-dropped, `--json`, timeout exit 3)
- `GLIMPSE_RUNTIME_TESTS=1 bash tests/test_*_cdp.sh` / `test_node_roundtrip.sh` —
  live-CDP, opt-in (need a running `glimpse open`). `test_multi_artifact_cdp.sh` proves
  two artifacts' audits coexist in `__glimpse_audit` and their threads stay isolated;
  `test_publish_audit_cdp.sh` is the end-to-end auto-audit warn/gate check against a
  real render.

## Testing & CI

- **GitHub CI** is `.github/workflows/ci.yml`. The `test` job (ubuntu + macOS)
  is the blocking gate: `bash -n`, `shellcheck -S warning` (no `|| true`),
  `node --test tests/test_*.cjs tests/test_*.mjs`, and a loop over
  `bash tests/test_*.sh`. There is **no Python leg** — glimpse runs on Node +
  Chrome only. The `secrets` job runs gitleaks over full history. See
  CONTRIBUTING.md for the local-run recipe.
- **Test taxonomy** under `tests/`:
  - `test_*.mjs` — `node:test` files, Node stdlib only. Some drive a ported lib
    op's exported functions (`test_glimpse_{export,threads_multi,explain,ask}.mjs`,
    `test_audit_report.mjs`); others are pure-logic (`test_poll.mjs`,
    `test_snapshot_render.mjs`, `test_bridge_origin.mjs`).
  - `test_*.cjs` — pure-logic `node:test` files using `dom-shim.cjs`; no browser.
  - `test_*.sh` — CLI smoke tests against an isolated `GLIMPSE_DIR`.
  - `cdp_assert_*.mjs` — **not** test files; CDP helpers invoked by the CDP shell
    tests. Never sweep them with `node --test` (the `test_*` glob excludes them).
- **Live-Chrome / CDP tests are opt-in and never run in CI.**
  `test_explain_render_cdp.sh` and `test_node_roundtrip.sh` self-skip (exit 0)
  unless `GLIMPSE_RUNTIME_TESTS=1` and a debuggable Chrome + canvas are up.
- **shellcheck** is gated at `-S warning` (the level the tree passes cleanly)
  and runs once, on the `ubuntu-latest` leg only — it's OS-independent static
  analysis and the macOS runner doesn't preinstall it. Remaining `SC2086`
  findings in `bin/glimpse` / `install.sh` are info-level; a `-S style`
  tightening is a deliberate follow-up, not a regression.
- The unit runner (`node:test`) has no assertion-rewrite cache, so a local run
  after editing a test always reflects the current source. CI is a fresh checkout
  regardless.
