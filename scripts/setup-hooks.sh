#!/usr/bin/env bash
# Enable the repo's git hooks (run once per clone).
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
git -C "$ROOT" config core.hooksPath .githooks
chmod +x "$ROOT"/.githooks/* "$ROOT"/scripts/*.sh 2>/dev/null || true
echo "✓ git hooks enabled (core.hooksPath=.githooks). Secret scan runs on commit + push."
