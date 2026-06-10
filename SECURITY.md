# Security Policy

## Reporting a vulnerability
Please report security issues privately via GitHub's **"Report a vulnerability"**
(Security → Advisories) on this repo, rather than opening a public issue.
We'll acknowledge within a few days.

## Security model (what to know as a user)
Glimpse drives a real Chrome over the Chrome DevTools Protocol. That power comes
with a trust boundary:

- **The CDP Chrome uses a dedicated profile** (`~/.glimpse/chrome-profile`), not
  your everyday browser. Anything you load or log into *in that window* is
  readable and controllable by the agent. Only sign into accounts you're
  comfortable letting the agent act on.
- **Everything binds to loopback.** The static server (`--bind 127.0.0.1`) and
  the Chrome debug socket (`--remote-debugging-address=127.0.0.1`) are not
  exposed on your network. Anyone able to run code as your user can still reach
  them — the same trust level as your shell.
- **Artifacts are sandboxed.** They load with `sandbox="allow-scripts"` (opaque
  origin): artifact JS can't reach the dashboard shell or other artifacts.
  Artifacts *can* still make outbound network requests (e.g. CDN scripts); audit
  artifacts or run offline if that matters to you.
- **Reusing an existing CDP port is flagged.** If a debuggable Chrome is already
  running on the configured port, Glimpse reuses it and prints a warning, since
  it may not be the dedicated profile. Set a different `GLIMPSE_CDP_PORT` to
  force isolation.

## Not committing secrets
This repo enforces secret scanning via git hooks (`scripts/check-secrets.sh`,
using gitleaks when available) and a hardened `.gitignore`. Run
`scripts/check-secrets.sh all` any time.
