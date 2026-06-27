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
    --mcp)
      MCP="${2:-}"
      case "$MCP" in claude|codex) ;; *) echo "--mcp requires 'claude' or 'codex'" >&2; exit 1;; esac
      shift;;
    *) echo "unknown flag: $1" >&2; exit 1;;
  esac; shift
done

echo "→ installing glimpse CLI to $PREFIX"
mkdir -p "$PREFIX"
install -m 0755 "$REPO/bin/glimpse" "$PREFIX/glimpse"

echo "→ seeding canvas at $GLIMPSE_DIR"
mkdir -p "$GLIMPSE_DIR/artifacts"
cp "$REPO/canvas/index.html" "$GLIMPSE_DIR/index.html"
cp "$REPO/canvas/glimpse-annotate.js" "$GLIMPSE_DIR/glimpse-annotate.js"   # highlight-chat helper (injected at render time)
cp "$REPO/canvas/glimpse-audit.js" "$GLIMPSE_DIR/glimpse-audit.js"         # render-correctness auditor (injected at render time)
mkdir -p "$GLIMPSE_DIR"
cp "$REPO/lib/glimpse_explain.py" "$GLIMPSE_DIR/glimpse_explain.py"   # explain engine (validate + wrap)
cp "$REPO/canvas/favicon.svg" "$GLIMPSE_DIR/favicon.svg"                   # tab icon
[ -f "$REPO/app/glimpse_menubar.py" ] && cp "$REPO/app/glimpse_menubar.py" "$GLIMPSE_DIR/glimpse_menubar.py"  # macOS menu-bar app
for ic in menubar-on.png menubar-off.png; do [ -f "$REPO/assets/$ic" ] && cp "$REPO/assets/$ic" "$GLIMPSE_DIR/$ic"; done  # menu-bar icons
cp -R "$REPO/examples" "$GLIMPSE_DIR/"           # so the quickstart works from any CWD
[ -f "$GLIMPSE_DIR/feed.json" ] || echo '{"artifacts":[]}' > "$GLIMPSE_DIR/feed.json"

if [ "$DO_SKILLS" = 1 ]; then
  echo "→ installing agent skills to $SKILLS_DIR"
  mkdir -p "$SKILLS_DIR"
  cp -R "$REPO/skills/canvas" "$SKILLS_DIR/"
  cp -R "$REPO/skills/chrome-cdp" "$SKILLS_DIR/"
  cp -R "$REPO/skills/explain" "$SKILLS_DIR/"
fi

if [ -n "$MCP" ] && ! command -v "$MCP" >/dev/null 2>&1; then
  echo "⚠ '$MCP' CLI not found on PATH — skipping MCP registration" >&2; MCP=""
fi
MCP_PORT="${GLIMPSE_CDP_PORT:-9222}"
if [ "$MCP" = "claude" ]; then
  echo "→ registering chrome-devtools MCP in Claude Code (port $MCP_PORT)"
  claude mcp add chrome-devtools --scope user -- npx chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:${MCP_PORT} \
    || echo "⚠ MCP registration failed (see output above); continuing" >&2
elif [ "$MCP" = "codex" ]; then
  echo "→ registering chrome-devtools MCP in Codex (port $MCP_PORT)"
  codex mcp add chrome-devtools -- npx chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:${MCP_PORT} \
    || echo "⚠ MCP registration failed (see output above); continuing" >&2
fi

# Enable secret-scanning git hooks when installing from inside the repo clone.
if git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "→ enabling secret-scanning git hooks"
  git -C "$REPO" config core.hooksPath .githooks
  chmod +x "$REPO"/.githooks/* "$REPO"/scripts/*.sh 2>/dev/null || true
fi

echo
echo "✓ installed."
case ":$PATH:" in
  *":$PREFIX:"*) :;;
  *) echo "  ⚠ $PREFIX is not on your PATH. Add it:"
     echo "      echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc   # or ~/.bashrc"
     echo "      then restart your shell";;
esac
echo "  Try:  glimpse doctor   then   glimpse open"
echo "  Uninstall:  launchctl bootout gui/\$(id -u)/com.glimpse.menubar 2>/dev/null; rm -f ~/Library/LaunchAgents/com.glimpse.menubar.plist"
echo "              rm -f $PREFIX/glimpse && rm -rf $GLIMPSE_DIR $SKILLS_DIR/canvas $SKILLS_DIR/chrome-cdp $SKILLS_DIR/explain"
