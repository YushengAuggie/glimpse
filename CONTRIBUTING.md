# Contributing to Glimpse

Thanks for your interest! Glimpse aims to stay tiny, dependency-light, and
easy to read.

## Principles
- **No build step, minimal deps.** The CLI is POSIX-ish bash; the canvas is one
  HTML file; the only runtime needs are Node (≥22) and Chrome. (Python 3 is
  optional — only the macOS menu-bar app uses it.)
- **Local-first & safe by default.** Servers bind to loopback; the CDP browser
  uses a dedicated profile; artifacts run sandboxed. Don't regress these.
- **Docs match behavior.** If you change a flag or default, update the README
  and `docs/`.

## Dev setup
```bash
git clone https://github.com/YushengAuggie/glimpse.git
cd glimpse
./scripts/setup-hooks.sh     # enable secret-scanning git hooks
./install.sh                 # install the CLI + canvas + skills locally
glimpse doctor
```

## Before you open a PR
- Run the test suite (see **Continuous integration** below) — it must be green.
- Run `scripts/check-secrets.sh all` — it must pass.
- Manually verify the flow: `glimpse open`, then `glimpse publish demo "Demo" examples/architecture-overview.html`.
- Keep changes focused; explain the "why" in the PR description.

## Continuous integration

Every push and pull request runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
These checks are **blocking** — a failure blocks the PR:

| Check | Command | Gates on |
| --- | --- | --- |
| Shell syntax | `bash -n bin/glimpse install.sh scripts/*.sh .githooks/*` | any parse error |
| Shell lint | `shellcheck -S warning bin/glimpse install.sh scripts/*.sh .githooks/*` | any `warning`+ finding |
| Unit tests | `node --test tests/test_*.cjs tests/test_*.mjs` | any failing test |
| Bash smoke tests | `bash tests/test_*.sh` | any failing test |
| Secret scan | `gitleaks git` (full history) | any leaked secret |

The `test` job runs on both `ubuntu-latest` and `macos-latest`, except the
shell-lint step, which runs once on Linux (shellcheck is OS-independent and the
macOS runner doesn't preinstall it); the `secrets` job runs once on Linux too.

**Run the whole gate locally** (Node ≥ 22 and
[shellcheck](https://www.shellcheck.net/) required — glimpse is Node + Chrome only,
no Python toolchain needed):

```bash
bash -n bin/glimpse install.sh scripts/*.sh .githooks/*   # syntax
shellcheck -S warning bin/glimpse install.sh scripts/*.sh .githooks/*
node --test tests/test_*.cjs tests/test_*.mjs             # unit tests, no deps
for t in tests/test_*.sh; do bash "$t"; done              # CDP tests self-skip
```

Notes:
- **Live-Chrome / CDP tests never run in CI.** `tests/test_explain_render_cdp.sh`
  and `tests/test_node_roundtrip.sh` self-skip unless `GLIMPSE_RUNTIME_TESTS=1`
  *and* a debuggable Chrome + canvas are already up. Run them by hand after
  `glimpse open` — don't rely on CI for them.
- shellcheck is gated at `-S warning`, the level the tree passes cleanly today.
  A few info-level `SC2086` findings remain in `bin/glimpse` / `install.sh`;
  tightening to `-S style` is a follow-up once those are quoted.
- Unit tests use Node's built-in runner (`node:test`) with no external deps.
  The SSE server test (`tests/test_glimpse_server_sse.mjs`) self-skips unless
  `GLIMPSE_RUNTIME_TESTS=1` (the hosted macOS runner can't complete its loopback
  server↔client setup).

## Secret scanning

This repo ships a guard so nothing sensitive reaches GitHub:

- `scripts/setup-hooks.sh` installs **pre-commit** + **pre-push** hooks that run
  [`scripts/check-secrets.sh`](scripts/check-secrets.sh), which uses
  [gitleaks](https://github.com/gitleaks/gitleaks) when available and falls back to
  a built-in regex scan otherwise.
- `.gitignore` excludes `.env*`, keys, and credential files.
- Run a manual scan any time: `scripts/check-secrets.sh all`.
- Override a false positive with `git commit --no-verify` (and only then).

## Reporting bugs
Open an issue with: OS, Chrome/Node versions (`glimpse doctor` output),
what you ran, and what happened.

## Security issues
Please **don't** file public issues for vulnerabilities — see
[`SECURITY.md`](SECURITY.md).
