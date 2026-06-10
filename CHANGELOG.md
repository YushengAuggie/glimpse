# Changelog

All notable changes to Glimpse are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]
### Added
- `glimpse` CLI: `open`, `publish`, `serve`, `chrome`, `read`, `shot`, `doctor`.
- Live auto-reloading canvas dashboard (`canvas/index.html`) with sandboxed,
  same-slug-reloadable artifacts and `#slug` deep-links.
- `install.sh` (CLI + canvas + agent skills; optional `--mcp claude|codex`).
- Agent skills: `canvas`, `chrome-cdp`.
- Secret-scanning guard: pre-commit + pre-push hooks, `scripts/check-secrets.sh`
  (gitleaks with a bash-3.2 regex fallback), hardened `.gitignore`.
- Docs: README, `docs/DESIGN.md`, `docs/USAGE.md`, `CONTRIBUTING.md`,
  `SECURITY.md`; examples for a system-design guide and the Glimpse how-to.
- CI: shell syntax, shellcheck, and gitleaks history scan.

### Security
- Static server and Chrome CDP bound to `127.0.0.1`.
- Artifacts run in an `allow-scripts`-only sandboxed iframe (opaque origin).
- Slug validation prevents path traversal.
- Warning when reusing an existing CDP endpoint (may not be the dedicated profile).
