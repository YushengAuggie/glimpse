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
# <!-- SPEC_EXAMPLE --> marker line.
SPEC="$(SKILL="$SKILL" node <<'JS'
const fs = require("fs");
// Build the code-fence literal from charCode 96 so no backtick appears in this
// heredoc body: macOS's bash 3.2 misparses backticks inside $(...) command
// substitution as nested command substitution, even in a quoted heredoc.
const fence = String.fromCharCode(96).repeat(3);
const lines = fs.readFileSync(process.env.SKILL, "utf-8").split(/\r?\n/);
const marker = "<!-- SPEC_EXAMPLE -->";
const mi = lines.findIndex((l) => l.trim() === marker);
if (mi < 0) { process.stderr.write("FAIL: " + marker + " marker not found in SKILL.md\n"); process.exit(1); }
// the fence must open on the very next line
if (mi + 1 >= lines.length || lines[mi + 1].trim() !== fence + "json") {
  process.stderr.write("FAIL: marker is not immediately followed by a json fence\n"); process.exit(1);
}
const body = [];
let closed = false;
for (const l of lines.slice(mi + 2)) {
  if (l.trim() === fence) { closed = true; break; }
  body.push(l);
}
if (!closed) { process.stderr.write("FAIL: unterminated json fence after marker\n"); process.exit(1); }
process.stdout.write(body.join("\n"));
JS
)"

# The extracted block must be valid JSON.
printf '%s' "$SPEC" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{JSON.parse(d)})' \
  || { echo "FAIL: example spec is not valid JSON"; exit 1; }

# It must pass the validator directly (the engine the verb shells out to).
MOD="$REPO/lib/glimpse-explain.mjs"
printf '%s' "$SPEC" | node "$MOD" validate \
  || { echo "FAIL: example spec rejected by validator"; exit 1; }
echo "skill-spec-ok"

# End-to-end: publish into the isolated GLIMPSE_DIR and assert the feed entry.
printf '%s' "$SPEC" | "$REPO/bin/glimpse" explain skill-example "Skill example" \
  >"$GLIMPSE_DIR/out.txt" \
  || { echo "FAIL: glimpse explain rejected the example spec"; cat "$GLIMPSE_DIR/out.txt"; exit 1; }
grep -q "published →" "$GLIMPSE_DIR/out.txt" || { echo "FAIL: no publish line"; exit 1; }

node <<'JS'
const fs = require("fs"), path = require("path");
const root = process.env.GLIMPSE_DIR;
const feed = JSON.parse(fs.readFileSync(path.join(root, "feed.json"), "utf-8"));
const a = feed.artifacts.find((x) => x.slug === "skill-example");
if (!a || a.kind !== "explain") { console.error("feed entry not kind=explain: " + JSON.stringify(a)); process.exit(1); }
if (!fs.existsSync(path.join(root, "artifacts", "skill-example.html"))) { console.error("artifact not written"); process.exit(1); }
console.log("feed-entry-ok");
JS

echo "ALL OK"
