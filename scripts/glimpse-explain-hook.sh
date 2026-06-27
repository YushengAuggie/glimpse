#!/usr/bin/env bash
# Opt-in Stop-hook nudge for the Glimpse code-explainer. No-op unless a per-repo
# marker exists AND a canvas is reachable. Never launches Chrome, never enables the
# daemon, never blocks. Emits at most one reminder line.
set -euo pipefail
root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
[ -f "$root/.glimpse-explain-auto" ] || exit 0
port="${GLIMPSE_PORT:-4321}"
curl -fsS -m 1 "http://127.0.0.1:${port}/feed.json" >/dev/null 2>&1 || exit 0
echo "glimpse: if you just made a non-trivial code change, consider producing an explainer (the 'explain' skill / 'glimpse explain') so it renders on the canvas."
exit 0
