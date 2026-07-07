# Changelog

All notable changes to Glimpse are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]
### Added
- **`glimpse poll` — one blocking call for human feedback.** Instead of running
  `glimpse bridge` under an agent Monitor, an in-the-loop agent now parks on a
  single `glimpse poll`: it blocks until there's undelivered feedback (a
  highlight/question), prints it, and returns (analogue of `lavish-axi poll`). It
  reuses the bridge's files-on-disk, pull-only machinery — draining the canvas
  outbox into the durable per-document thread store and blocking on the pending
  queue — so queued feedback survives if the agent wasn't polling yet and each
  poll delivers the next item (nothing dropped). Dedup is a `.poll.state` cursor
  that never mutates turn status, so the canvas keeps showing "awaiting answer"
  until you `reply`. Degrades to disk-only when Chrome is down; `--timeout N`
  (`0` = wait forever) with a heartbeat and exit code **3** on timeout means no
  infinite hang. Default output is a compact, token-efficient TAB-separated record
  format (self-describing header; `anchor` as `text:<occ>`/`node:<id>`/`-`); pass
  `--json` for plain JSON. `glimpse list --json` and a `ts` field on
  `glimpse __pending` round out the machine-readable output. Loopback-only and
  secret-scrubbed like the bridge; `glimpse bridge`/`daemon` are unchanged.
- **`glimpse audit <slug>` — render-correctness loop.** An auditor is injected
  into every artifact; after fonts load and layout settles it checks the *real*
  browser render for horizontal/element overflow, clipped text, and overlapping
  text (Glimpse's own highlight marks excluded). `glimpse audit` reports the
  findings (with selectors + severity) and exits non-zero on errors, so an agent
  can catch an unreadable layout before a human sees it. (Inspired by lavish-axi.)
- **Follow-up conversations.** A comment is now a growing thread anchored to one
  passage: each answered comment has a reply box (Enter sends, Shift+Enter for a
  newline, or the **Send** button) so you can keep asking. Turns render in
  chronological order (user/agent/user/agent…); the daemon answers each follow-up
  with the prior turns of that passage as context, so replies stay coherent. The
  liveness pill shows a brief "connecting…" after a reload instead of flashing
  "offline".
- **Always-on agent: `glimpse daemon` + a macOS menu-bar app.** `glimpse daemon`
  is the bridge plus auto-answering each highlighted question by calling a local
  Anthropic-compatible proxy (`GLIMPSE_PROXY_URL`, default derived from
  `ANTHROPIC_BASE_URL` or `http://127.0.0.1:8787/v1/messages`; key from
  `GLIMPSE_API_KEY`/`POE_API_KEY`; model `GLIMPSE_MODEL`, default
  `claude-haiku-4-5`) and writing the reply — so the canvas answers without a
  human session. Q&A only: the question text is untrusted data, never executed;
  emits `proxy_unavailable` on failure. `glimpse menubar` launches a `rumps`
  status-bar app (👁) to **click-to-toggle** online/offline, "Open canvas", and
  "Start at login" (a LaunchAgent that sources `~/.config/secrets.env`) for true
  always-on. Menu-bar app is macOS-only; `glimpse daemon` is the cross-platform CLI.
- **Highlight-to-chat**: select any passage in an artifact and ask the agent about
  it; the answer threads as an inline margin comment anchored to the highlight, and
  the conversation is persisted per-document (`~/.glimpse/threads/<slug>.json`) so it
  survives refreshes and new sessions. New CLI verbs `glimpse bridge` (streams
  questions as JSON lines, run under an agent Monitor), `glimpse reply <slug>
  "answer" --to <turnId>`, `glimpse thread <slug> [--json|--clear]`, `glimpse threads`.
  The selection helper (`canvas/glimpse-annotate.js`) is auto-injected at render time
  (artifacts on disk stay pristine) inside a Shadow DOM; disable with `--no-annotate`
  or `GLIMPSE_ANNOTATE=0`. A header pill shows whether an agent is listening and
  toggles a reading mode. The bridge *pulls* questions over the existing CDP channel
  (no new inbound endpoint); questions are durable the instant they're asked, and
  delivery is idempotent across bridge restarts (cursor + seen-set in `bridge.state`).
  `rm`/`clear` clean up the matching thread file; thread turns are secret-scrubbed,
  size-capped, `0600`, and written atomically under `flock`.
- **Brand icon**: `canvas/favicon.svg` (tab icon, wired into the canvas) and
  `assets/glimpse-icon.svg` (README / social) — a flat eye-on-dark-tile mark.
- **Sidebar management**: `glimpse list`, `glimpse rm <slug>...`,
  `glimpse clear --all|--keep N` (pinned always kept), `glimpse pin/unpin <slug>`
  (persists across re-publish). Canvas gains a filter box, a 📌 Pinned section,
  and older items collapsed behind a "N older" toggle.
- **Two-way `glimpse ask`** — publish an interactive artifact and block until the
  user answers (approve/reject, pick-one, note), returned as JSON. The artifact
  stays in the `allow-scripts` sandbox and replies via `postMessage` →
  validated by the shell → read back over CDP (no inbound network endpoint).
  Sidebar shows an "awaiting you" → "answered" badge. New `examples/ask-template.html`.
- `glimpse stop` (+ server PID file).

### Changed
- **One-command install + loud, actionable `glimpse doctor`.** `install.sh` now
  runs a preflight (node ≥22, python3, Chrome) with an OS-aware, copy-pasteable
  fix per missing dep, then installs the CLI + assets regardless; a missing
  *required* dep (node/python3) still installs the CLI but exits non-zero, while
  a missing Chrome is a warning only. `glimpse doctor` is reformatted to one
  `✓`/`✗`/`⚠`/`–` line per check, each `✗`/`⚠` followed by a `→ <fix>`, exiting
  non-zero when a required check fails. On macOS it also verifies the launchd
  menu-bar daemon and whether its minimal login-shell PATH can resolve
  `node`/`python3` — the classic silent failure — with a `GLIMPSE_NODE` fix.
- **Friendlier message boxes (annotate rail + code-explainer composer).**
  **Enter** now sends and **Shift+Enter** inserts a newline (⌘/Ctrl+Enter still
  sends); an IME-composition Enter — e.g. picking a Chinese/Japanese candidate —
  never sends. Inputs **auto-grow** to fit what you type (capped, then scroll)
  while still allowing a manual drag-resize. Agent replies in the annotate rail
  now render as **Markdown** (bold/italic/code/links/lists/headings) via the same
  DOM-only `safeMarkdown` path the explainer uses — never `innerHTML`.

### Fixed (post-review)
- Concurrent `publish` no longer races `feed.json` (exclusive `flock`).
- CDP calls now reject on protocol error and time out per-call (no more hangs if
  Chrome dies); shared CDP helper replaces three drifting copies.
- `glimpse read` waits for `Page.loadEventFired` instead of a fixed sleep; guards null body.
- `glimpse shot` no longer crashes when no page tab exists.
- `glimpse doctor` gates on Node ≥22 and exits non-zero when a dep is missing.
- `glimpse help` no longer leaks raw script source; numeric port validation.
- Installer copies `examples/` to `~/.glimpse` (quickstart works from any CWD),
  prints a PATH snippet, and an uninstall hint.

### Original
- `glimpse` CLI: `open`, `publish`, `serve`, `chrome`, `read`, `shot`, `doctor`.
- Live auto-reloading canvas dashboard (`canvas/index.html`) with sandboxed,
  same-slug-reloadable artifacts and `#slug` deep-links.
- `install.sh` (CLI + canvas + agent skills; optional `--mcp claude|codex`).
- Agent skills: `canvas`, `chrome-cdp`.
- Secret-scanning guard: pre-commit + pre-push hooks, `scripts/check-secrets.sh`
  (gitleaks with a bash-3.2 regex fallback), hardened `.gitignore`.
- Docs: README, `docs/DESIGN.md`, `docs/USAGE.md`, `CONTRIBUTING.md`,
  `SECURITY.md`; examples for an architecture overview and the Glimpse how-to.
- CI: shell syntax, shellcheck, and gitleaks history scan.

### Security
- Static server and Chrome CDP bound to `127.0.0.1`.
- Artifacts run in an `allow-scripts`-only sandboxed iframe (opaque origin).
- Slug validation prevents path traversal.
- Warning when reusing an existing CDP endpoint (may not be the dedicated profile).
