# Changelog

All notable changes to Glimpse are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]
### Added
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
