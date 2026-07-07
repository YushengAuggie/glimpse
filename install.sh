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
OS="$(uname -s)"

have(){ command -v "$1" >/dev/null 2>&1; }

# Locate a usable Chrome/Chromium the same way `glimpse` (detect_chrome) does at
# runtime, so the installer verifies the exact binary the tool will drive.
find_chrome(){
  if [ -n "${GLIMPSE_CHROME:-}" ]; then
    [ -x "$GLIMPSE_CHROME" ] && { echo "$GLIMPSE_CHROME"; return 0; }
    return 1
  fi
  local c
  for c \
    in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
       "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" \
       "/Applications/Chromium.app/Contents/MacOS/Chromium" \
       google-chrome google-chrome-stable chromium chromium-browser; do
    if [ -x "$c" ]; then echo "$c"; return 0; fi
    if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return 0; fi
  done
  return 1
}

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

# --- preflight: verify the runtime, with copy-pasteable fixes ---------------
# node 22+ and python3 are REQUIRED (they fail the install non-zero so scripts
# notice), but the CLI + assets are still installed first so `glimpse doctor`
# is available to re-diagnose. Chrome is a warning: it is driven at runtime and
# `glimpse doctor` re-checks it, so a missing browser never blocks the install.
echo "→ checking prerequisites"
MISSING_REQUIRED=0
CHROME_MISSING=0

if have node && node -e 'process.exit(parseInt(process.version.slice(1),10)>=22?0:1)' 2>/dev/null; then
  echo "  ✓ node $(node --version)"
else
  MISSING_REQUIRED=1
  if have node; then echo "  ✗ node $(node --version) is too old — glimpse drives Chrome over CDP and needs node 22+ (global WebSocket)"
  else echo "  ✗ node not found — glimpse drives Chrome over CDP and needs node 22+"; fi
  case "$OS" in
    Darwin) echo "      fix:  brew install node          # or: fnm install 22 && fnm default 22";;
    *)      echo "      fix:  install Node 22+ from https://nodejs.org   (or: fnm install 22)";;
  esac
fi

if have python3; then echo "  ✓ $(python3 --version 2>&1)"
else
  MISSING_REQUIRED=1
  echo "  ✗ python3 not found — glimpse serves the canvas with Python's http.server"
  case "$OS" in
    Darwin) echo "      fix:  xcode-select --install     # or: brew install python3";;
    *)      echo "      fix:  install Python 3 (e.g. apt install python3)";;
  esac
fi

if CHROME_PATH="$(find_chrome)"; then echo "  ✓ chrome $CHROME_PATH"
else
  CHROME_MISSING=1
  echo "  ⚠ Chrome/Chromium not found — glimpse renders artifacts in a Chrome it drives over CDP"
  case "$OS" in
    Darwin) echo "      fix:  brew install --cask google-chrome   # or https://www.google.com/chrome/";;
    *)      echo "      fix:  install Google Chrome/Chromium, or set GLIMPSE_CHROME=/path/to/chrome";;
  esac
fi

echo "→ installing glimpse CLI to $PREFIX"
mkdir -p "$PREFIX"
install -m 0755 "$REPO/bin/glimpse" "$PREFIX/glimpse"

echo "→ seeding canvas at $GLIMPSE_DIR"
mkdir -p "$GLIMPSE_DIR/artifacts"
cp "$REPO/canvas/index.html" "$GLIMPSE_DIR/index.html"
cp "$REPO/canvas/glimpse-annotate.js" "$GLIMPSE_DIR/glimpse-annotate.js"   # highlight-chat helper (injected at render time)
cp "$REPO/canvas/glimpse-audit.js" "$GLIMPSE_DIR/glimpse-audit.js"         # render-correctness auditor (injected at render time)
mkdir -p "$GLIMPSE_DIR"
# CLI lib code the dispatcher shells out to (Python ops + the CDP client/bridge).
# Seeded flat into $GLIMPSE_DIR so an installed `glimpse` (whose $SELF_DIR/../lib
# doesn't exist) resolves them via _lib_file. Keep in sync with lib/ and bin/glimpse.
for f in glimpse_explain.py glimpse_feed.py glimpse_threads.py glimpse_server.py \
         glimpse_chrome_profile.py glimpse_export.py glimpse_share.py \
         glimpse-cdp.mjs glimpse-bridge.mjs glimpse-poll.mjs glimpse-snapshot.mjs; do
  cp "$REPO/lib/$f" "$GLIMPSE_DIR/$f"
done
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
case ":$PATH:" in
  *":$PREFIX:"*) :;;
  *) echo "  ⚠ $PREFIX is not on your PATH. Add it:"
     echo "      echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc   # or ~/.bashrc"
     echo "      then restart your shell";;
esac

if [ "$MISSING_REQUIRED" = 1 ]; then
  echo "✗ installed the CLI, but required prerequisites are missing (see fixes above)."
  echo "  glimpse won't work until you install them, then verify with:  glimpse doctor" >&2
  echo "  Uninstall:  launchctl bootout gui/\$(id -u)/com.glimpse.menubar 2>/dev/null; rm -f ~/Library/LaunchAgents/com.glimpse.menubar.plist"
  echo "              rm -f $PREFIX/glimpse && rm -rf $GLIMPSE_DIR $SKILLS_DIR/canvas $SKILLS_DIR/chrome-cdp $SKILLS_DIR/explain"
  exit 1
fi

echo "✓ installed."
[ "$CHROME_MISSING" = 1 ] && echo "  ⚠ install Chrome (see above) before 'glimpse open' — 'glimpse doctor' will re-check it."
echo "  Next:  glimpse doctor   then   glimpse open"
echo "  Uninstall:  launchctl bootout gui/\$(id -u)/com.glimpse.menubar 2>/dev/null; rm -f ~/Library/LaunchAgents/com.glimpse.menubar.plist"
echo "              rm -f $PREFIX/glimpse && rm -rf $GLIMPSE_DIR $SKILLS_DIR/canvas $SKILLS_DIR/chrome-cdp $SKILLS_DIR/explain"
