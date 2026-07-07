# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Install & doctor conventions

- **`install.sh` is one idempotent command.** It runs a preflight (node ≥22, python3, Chrome) printing `✓`/`✗`/`⚠` with a copy-pasteable, OS-aware fix per line, then installs the CLI + canvas assets regardless. Node and python3 are **required**: if either is missing the installer still installs the CLI (so `glimpse doctor` can re-diagnose) but exits non-zero. Chrome is a **warning only** — it is driven at runtime and doctor re-checks it, so a missing browser never blocks the install. Re-running is always safe.
- **`glimpse doctor` (`cmd_doctor`) is loud and scriptable.** One line per check with a marker: `✓` good · `✗` broken (fails the run) · `⚠` optional/degraded · `–` informational state. Every `✗`/`⚠` is followed by a `→ <fix>` line. It **exits non-zero** when a *required* check fails (bash, python3, node ≥22, chrome, curl, and — when the launchd daemon is configured — the job load + its resolved node/python3). Live-service state (server/CDP port down, bridge not running, proxy unreachable, api key unset) is informational and never fails the run, since "down before `glimpse open`" is normal.
- **The classic silent failure is launchd's minimal PATH.** The always-on menu-bar daemon runs `/bin/bash -lc 'source ~/.config/secrets.env; exec glimpse menubar'`; launchd's login shell misses the fnm/nvm setup that only zsh sources, so `node` (and sometimes `python3`) can't be found and CDP calls die quietly. `_ensure_node` prepends `_node_candidates` (stable install dirs) as a workaround; `cmd_doctor`'s `_launchd_resolve` reproduces that exact env to report whether the daemon would find them, and reuses the same `_node_candidates` list so the check never drifts. Pin with `GLIMPSE_NODE` in `~/.config/secrets.env`.
- **Scope discipline:** only `install.sh` and `cmd_doctor` (plus shared helpers `_node_candidates` / `_launchd_resolve`) own this behavior. Don't add network calls beyond the dependency version probes already present, and keep loopback/secret-scrub posture intact.

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
| `glimpse-cdp.mjs` | `run_cdp`, `cmd_bridge` | shared CDP client (`cdpConnect`, `fail`) — **spliced** ahead of the body via `node --input-type=module -e "$(cat …)"` |
| `glimpse-bridge.mjs` | `cmd_bridge` | the highlight-chat bridge loop — spliced after `glimpse-cdp.mjs`; env `GLIMPSE_BIN WAIT PORT GLIMPSE_DIR` (+ daemon `GLIMPSE_ANSWER …`) |
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

## Live-app review — drive Chrome to a real running app and inspect/interact

Glimpse markets itself as a static-artifact canvas, but the same shared CDP channel
also lets an agent **review a live running app**: point Chrome at the app under
development and inspect the REAL page (state, console, network-driven content) — the
thing a static-artifact tool cannot see. The flow is `glimpse open <url>` once, then
inspect and interact against that tab.

**Inspect (read-only — never mutate the page):**

- **`glimpse read [url]`** — navigate to `url` (or read the current app tab when
  omitted) and print `{title,url,text,console,errors}` JSON. The **console output +
  uncaught errors captured during load** are the review payoff — subscribed *before*
  navigation via the new persistent `on()` subscription on the CDP client, so early
  logs aren't missed. Text is capped (8000 chars), console/errors keep the most
  recent 50 (300 chars each). The text/console sibling of `shot` (pixels) and
  `snapshot` (a11y tree). Body: `lib/glimpse-read.mjs`.
- **`glimpse shot <out.png> [url]`** — screenshot the current (or given) page.
- **`glimpse snapshot [#slug|url]`** — a11y-tree outline (see above).

**Interact (the ONLY intentionally state-changing browser verbs — each a deliberate
command, never a side effect of reading):**

- **`glimpse click <css-selector>`** — `scrollIntoView` then `.click()` the first
  match; reports `{ok,tag,text,…}`.
- **`glimpse scroll <selector> | --to <px> | --by <px>`** — exactly one target; scroll
  into an element, to an absolute Y, or by a delta.
- **`glimpse wait <selector> | --text <str> [--timeout N]`** — poll (200ms) until an
  element is visible or text appears; default 8s timeout. Exits non-zero on timeout.

Interaction bodies live in `lib/glimpse-interact.mjs` (`ACTION=click|scroll|wait`).
A failed action (`ok:false`) exits `2`.

**Tab selection — `cdpConnectApp` (in `lib/glimpse-cdp.mjs`), NOT `cdpConnect`.**
Live-app verbs must act on the *app's* tab, never clobber the canvas. With a target
URL, `cdpConnectApp(url)` matches the page by **host** (reuses the app tab, opening a
fresh one only if none exists — exactly how `glimpse open` chooses). With no URL, it
prefers a **non-canvas** page (the app under review) over the canvas tab (canvas =
`127.0.0.1:$PORT`/`localhost:$PORT`), then falls back to any page. `read`, `shot`,
`snapshot`, and `interact` all route through it — no second browser connection.

**Security posture (unchanged):** names/text/console/element text are secret-scrubbed
against `SECRET_PATTERN` (same posture as thread turns / snapshot), so a token that
slipped into the page or a log line is never surfaced. `chrome-cdp` skill (v1.1.0)
advertises the flow ("review the running app", "screenshot the app").

## Tests

- `uv run --with pytest pytest tests/` — Python units (incl. `test_glimpse_export.py`, the inliner)
- `node --test tests/*.mjs tests/*.cjs` — renderer/bridge units (no deps); includes
  `test_snapshot_render.mjs`, which drives the real `lib/glimpse-snapshot.mjs` body
  with a stubbed CDP channel (no browser) to cover tree-building, node collapsing,
  iframe grafting, and secret scrubbing; and `test_read_render.mjs` /
  `test_interact_render.mjs`, which drive the real `lib/glimpse-read.mjs` /
  `lib/glimpse-interact.mjs` bodies with a stubbed `cdpConnectApp` (no browser) to
  cover console/error accumulation, the text cap, JSON shape, click/scroll/wait, and
  secret scrubbing
- `bash tests/test_explain_cli.sh`, `bash tests/test_node_anchor.sh`, `bash tests/test_export_cli.sh` — CLI smoke (the export test is offline; it never uploads)
- `GLIMPSE_RUNTIME_TESTS=1 bash tests/test_*_cdp.sh` / `test_node_roundtrip.sh` —
  live-CDP, opt-in (need a running `glimpse open`); includes `test_liveapp_cdp.sh`,
  the end-to-end live-app review smoke (serve a local app, open it, then
  read/shot/snapshot/click/scroll/wait against the real page)
