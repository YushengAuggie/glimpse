#!/usr/bin/env bash
# Asserts the explain skill's canonical example spec is genuinely valid and is
# accepted by the publish engine. Extracts the json block marked
# `<!-- SPEC_EXAMPLE -->` in skills/explain/SKILL.md, validates it, then pipes it
# through `bin/glimpse explain` into an isolated GLIMPSE_DIR and checks the feed
# entry is kind=explain. Never touches ~/.glimpse or the live canvas.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SKILL="$REPO/skills/explain/SKILL.md"
export GLIMPSE_DIR; GLIMPSE_DIR="$(mktemp -d)"
trap 'rm -rf "$GLIMPSE_DIR"' EXIT

[ -f "$SKILL" ] || { echo "FAIL: $SKILL not found"; exit 1; }

# Extract the example spec: the ```json fence immediately after the
# <!-- SPEC_EXAMPLE --> marker line. (json.loads also rejects a stray marker.)
SPEC="$(SKILL="$SKILL" python3 - <<'PY'
import os, sys
lines = open(os.environ["SKILL"], encoding="utf-8").read().splitlines()
marker = "<!-- SPEC_EXAMPLE -->"
try:
    mi = next(i for i, l in enumerate(lines) if l.strip() == marker)
except StopIteration:
    sys.stderr.write("FAIL: %s marker not found in SKILL.md\n" % marker)
    sys.exit(1)
# the fence must open on the very next line
if mi + 1 >= len(lines) or lines[mi + 1].strip() != "```json":
    sys.stderr.write("FAIL: marker is not immediately followed by a ```json fence\n")
    sys.exit(1)
body = []
for l in lines[mi + 2:]:
    if l.strip() == "```":
        break
    body.append(l)
else:
    sys.stderr.write("FAIL: unterminated ```json fence after marker\n")
    sys.exit(1)
sys.stdout.write("\n".join(body))
PY
)"

# The extracted block must be valid JSON.
printf '%s' "$SPEC" | python3 -c 'import json,sys; json.load(sys.stdin)' \
  || { echo "FAIL: example spec is not valid JSON"; exit 1; }

# It must pass the validator directly (the engine the verb shells out to).
MOD="$REPO/lib/glimpse_explain.py"
printf '%s' "$SPEC" | python3 "$MOD" validate \
  || { echo "FAIL: example spec rejected by validator"; exit 1; }
echo "skill-spec-ok"

# End-to-end: publish into the isolated GLIMPSE_DIR and assert the feed entry.
printf '%s' "$SPEC" | "$REPO/bin/glimpse" explain skill-example "Skill example" \
  >"$GLIMPSE_DIR/out.txt" \
  || { echo "FAIL: glimpse explain rejected the example spec"; cat "$GLIMPSE_DIR/out.txt"; exit 1; }
grep -q "published →" "$GLIMPSE_DIR/out.txt" || { echo "FAIL: no publish line"; exit 1; }

python3 - <<'PY'
import json, os
root = os.environ["GLIMPSE_DIR"]
feed = json.load(open(os.path.join(root, "feed.json")))
a = next(x for x in feed["artifacts"] if x["slug"] == "skill-example")
assert a.get("kind") == "explain", "feed entry not kind=explain: %r" % a
assert os.path.isfile(os.path.join(root, "artifacts", "skill-example.html")), "artifact not written"
print("feed-entry-ok")
PY

echo "ALL OK"
