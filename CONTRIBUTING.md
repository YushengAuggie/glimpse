# Contributing to Glimpse

Thanks for your interest! Glimpse aims to stay tiny, dependency-light, and
easy to read.

## Principles
- **No build step, minimal deps.** The CLI is POSIX-ish bash; the canvas is one
  HTML file; the only runtime needs are Node, Python 3, and Chrome.
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
- Run `bash -n bin/glimpse scripts/*.sh .githooks/*` (syntax check). If you have
  [shellcheck](https://www.shellcheck.net/), run it too.
- Run `scripts/check-secrets.sh all` — it must pass.
- Manually verify the flow: `glimpse open`, then `glimpse publish demo "Demo" examples/architecture-overview.html`.
- Keep changes focused; explain the "why" in the PR description.

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
Open an issue with: OS, Chrome/Node/Python versions (`glimpse doctor` output),
what you ran, and what happened.

## Security issues
Please **don't** file public issues for vulnerabilities — see
[`SECURITY.md`](SECURITY.md).
