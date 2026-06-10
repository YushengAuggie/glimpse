#!/usr/bin/env bash
# Secret scanner for the glimpse repo. Used by the git hooks and CI.
#
#   scripts/check-secrets.sh staged   # scan staged changes (pre-commit)
#   scripts/check-secrets.sh all      # gitleaks: full history; fallback: tracked files (pre-push/CI)
#
# Prefers gitleaks if installed; otherwise falls back to a built-in regex scan
# so the guard still works on machines without gitleaks.
set -euo pipefail
MODE="${1:-staged}"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

red(){ printf '\033[31m%s\033[0m\n' "$*"; }
grn(){ printf '\033[32m%s\033[0m\n' "$*"; }

if command -v gitleaks >/dev/null 2>&1; then
  if [ "$MODE" = "all" ]; then
    gitleaks git --no-banner --redact 2>&1 || { red "✗ gitleaks found potential secrets (history). Push blocked."; exit 1; }
  else
    gitleaks git --staged --no-banner --redact 2>&1 || { red "✗ gitleaks found potential secrets (staged). Commit blocked."; exit 1; }
  fi
  grn "✓ gitleaks: no secrets detected ($MODE)"
  exit 0
fi

# ---- Fallback: regex scan (no gitleaks installed) -------------------------
# Note: this is a best-effort net, weaker than gitleaks. In "all" mode it scans
# tracked files in the current tree (not full history); "staged" mode scans the
# staged blob content. Install gitleaks for history + entropy coverage.
echo "gitleaks not found — using built-in regex fallback (install gitleaks for stronger coverage)"

# High-signal patterns. Specific on purpose to limit false positives.
PATTERN='AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|sk-(proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN ([A-Z ]+ )?PRIVATE KEY-----|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20}'
# Sensitive filenames that should never be committed.
NAME_PATTERN='(^|/)(\.env(\..*)?|\.npmrc|\.netrc|.*\.pem|.*\.p12|.*\.pfx|.*id_rsa|.*id_ed25519|secrets?\.(env|ya?ml|json)|auth\.json|credentials(\.json)?)$'

# NUL-delimited file lists so names with spaces work. Process substitution +
# `read -d ''` keep this compatible with bash 3.2 (macOS) — no mapfile (bash 4+).
gen_files(){
  if [ "$MODE" = "all" ]; then git ls-files -z
  else git diff --cached --name-only --diff-filter=ACM -z; fi
}

hits=0; scanned=0
while IFS= read -r -d '' f; do
  [ -n "$f" ] || continue
  scanned=1
  if printf '%s\n' "$f" | grep -qiE "$NAME_PATTERN"; then
    red "✗ sensitive filename: $f"; hits=1; continue
  fi
  # Pull content: staged blob in commit mode, worktree file in all mode.
  if [ "$MODE" = "all" ]; then
    [ -f "$f" ] || continue
    content="$(cat -- "$f" 2>/dev/null)"
  else
    content="$(git show ":$f" 2>/dev/null)" || continue
  fi
  if matches="$(printf '%s\n' "$content" | grep -nE "$PATTERN" 2>/dev/null)"; then
    red "✗ potential secret in $f:"
    # Redact the secret itself before printing.
    printf '%s\n' "$matches" | sed -E "s/($PATTERN)/[REDACTED]/g" | sed 's/^/    /'
    hits=1
  fi
done < <(gen_files)
[ "$scanned" -eq 0 ] && { grn "✓ nothing to scan"; exit 0; }

if [ "$hits" -ne 0 ]; then
  red "Secret check failed. Remove the secret (and rotate it if it was ever real)."
  echo "Override only if you are certain it is a false positive:  git commit --no-verify"
  exit 1
fi
grn "✓ regex scan: no secrets detected ($MODE)"
