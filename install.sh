#!/usr/bin/env bash
# Install glimpse: the CLI, the canvas assets, and (optionally) the agent skills
# and the chrome-devtools MCP server.
#
#   ./install.sh                 # CLI + canvas + skills
#   ./install.sh --no-skills     # CLI + canvas only
#   ./install.sh --mcp claude    # also register chrome-devtools MCP in Claude Code
#   ./install.sh --mcp codex     # ...in Codex CLI
#   PREFIX=~/bin ./install.sh    # install the CLI somewhere else on PATH
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${PREFIX:-$HOME/.local/bin}"
GLIMPSE_DIR="${GLIMPSE_DIR:-$HOME/.glimpse}"
SKILLS_DIR="${SKILLS_DIR:-$HOME/.claude/skills}"
DO_SKILLS=1; MCP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --no-skills) DO_SKILLS=0;;
    --mcp) MCP="${2:-}"; shift;;
    *) echo "unknown flag: $1" >&2; exit 1;;
  esac; shift
done

echo "→ installing glimpse CLI to $PREFIX"
mkdir -p "$PREFIX"
install -m 0755 "$REPO/bin/glimpse" "$PREFIX/glimpse"

echo "→ seeding canvas at $GLIMPSE_DIR"
mkdir -p "$GLIMPSE_DIR/artifacts"
cp "$REPO/canvas/index.html" "$GLIMPSE_DIR/index.html"
[ -f "$GLIMPSE_DIR/feed.json" ] || echo '{"artifacts":[]}' > "$GLIMPSE_DIR/feed.json"

if [ "$DO_SKILLS" = 1 ]; then
  echo "→ installing agent skills to $SKILLS_DIR"
  mkdir -p "$SKILLS_DIR"
  cp -R "$REPO/skills/canvas" "$SKILLS_DIR/"
  cp -R "$REPO/skills/chrome-cdp" "$SKILLS_DIR/"
fi

if [ "$MCP" = "claude" ]; then
  echo "→ registering chrome-devtools MCP in Claude Code"
  claude mcp add chrome-devtools --scope user -- npx chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:9222 || true
elif [ "$MCP" = "codex" ]; then
  echo "→ registering chrome-devtools MCP in Codex"
  codex mcp add chrome-devtools -- npx chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:9222 || true
fi

echo
echo "✓ installed."
case ":$PATH:" in *":$PREFIX:"*) :;; *) echo "  ⚠ $PREFIX is not on your PATH — add it to your shell profile.";; esac
echo "  Try:  glimpse doctor   then   glimpse open"
