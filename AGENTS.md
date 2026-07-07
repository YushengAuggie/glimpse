# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Install & doctor conventions

- **`install.sh` is one idempotent command.** It runs a preflight (node ≥22, python3, Chrome) printing `✓`/`✗`/`⚠` with a copy-pasteable, OS-aware fix per line, then installs the CLI + canvas assets regardless. Node and python3 are **required**: if either is missing the installer still installs the CLI (so `glimpse doctor` can re-diagnose) but exits non-zero. Chrome is a **warning only** — it is driven at runtime and doctor re-checks it, so a missing browser never blocks the install. Re-running is always safe.
- **`glimpse doctor` (`cmd_doctor`) is loud and scriptable.** One line per check with a marker: `✓` good · `✗` broken (fails the run) · `⚠` optional/degraded · `–` informational state. Every `✗`/`⚠` is followed by a `→ <fix>` line. It **exits non-zero** when a *required* check fails (bash, python3, node ≥22, chrome, curl, and — when the launchd daemon is configured — the job load + its resolved node/python3). Live-service state (server/CDP port down, bridge not running, proxy unreachable, api key unset) is informational and never fails the run, since "down before `glimpse open`" is normal.
- **The classic silent failure is launchd's minimal PATH.** The always-on menu-bar daemon runs `/bin/bash -lc 'source ~/.config/secrets.env; exec glimpse menubar'`; launchd's login shell misses the fnm/nvm setup that only zsh sources, so `node` (and sometimes `python3`) can't be found and CDP calls die quietly. `_ensure_node` prepends `_node_candidates` (stable install dirs) as a workaround; `cmd_doctor`'s `_launchd_resolve` reproduces that exact env to report whether the daemon would find them, and reuses the same `_node_candidates` list so the check never drifts. Pin with `GLIMPSE_NODE` in `~/.config/secrets.env`.
- **Scope discipline:** only `install.sh` and `cmd_doctor` (plus shared helpers `_node_candidates` / `_launchd_resolve`) own this behavior. Don't add network calls beyond the dependency version probes already present, and keep loopback/secret-scrub posture intact.

## `bin/glimpse` is a pure bash dispatcher — no polyglot heredocs

The CLI verbs live in `bin/glimpse`, but the Python and JavaScript they used to
embed as `<<'PY'` / `<<'JS'` heredocs now live in real files under `lib/`. The
dispatcher shells out to them; **do not reintroduce polyglot heredoc bodies in
`bin/glimpse`.** Small inline one-liners (`python3 -c`, `python3 --version`, and
the per-verb JS bodies passed to `run_cdp`) are fine.

### `lib/` layout

| File | Invoked by | Interface |
|------|-----------|-----------|
| `glimpse_feed.py` | `feed_upsert`, `_feed_op`, `cmd_list` | `python3 … {upsert\|op\|list}`; args via env (`SLUG TITLE TS PENDING NOANNOTATE KIND`, `ACTION SLUGS KEEP SLUG`, `GLIMPSE_DIR`) |
| `glimpse_threads.py` | `_thread_op`, `cmd_threads`, `cmd__pending` | `python3 … {op\|list\|pending}`; env `ACTION SLUG QUOTE TEXT ANCHOR CLIENT_TURN_ID ARTIFACT_TS TO TS SECRET_PATTERN GLIMPSE_DIR` |
| `glimpse_server.py` | `cmd_serve` | `python3 … <port> <root>` (argv) — loopback-bound quiet static server |
| `glimpse_chrome_profile.py` | `cmd_chrome` | `python3 … <profile-dir>` (argv) + env `GLIMPSE_PROFILE_LABEL`; best-effort |
| `glimpse_explain.py` | `cmd_explain` | `python3 … wrap <title>` (pre-existing) |
| `glimpse_ask.py` | `cmd_ask` (`--form` only) | `python3 … {validate\|wrap <title>}` — reads a decision-form spec on stdin, renders native accessible controls (see "`glimpse ask --form`" below) |
| `glimpse-cdp.mjs` | `run_cdp`, `cmd_bridge` | shared CDP client (`cdpConnect`, `fail`) — **spliced** ahead of the body via `node --input-type=module -e "$(cat …)"` |
| `glimpse-bridge.mjs` | `cmd_bridge` | the highlight-chat bridge loop — spliced after `glimpse-cdp.mjs`; env `GLIMPSE_BIN WAIT PORT GLIMPSE_DIR` (+ daemon `GLIMPSE_ANSWER …`) |

`glimpse-cdp.mjs` / `glimpse-bridge.mjs` are the verbatim former `CDP_HELPER` /
`BRIDGE_JS` heredoc bodies with **no `import`/`export`** — they are concatenated
by the shell (`… -e "$(cat cdp)"$'\n'"$(cat bridge)"`), exactly as the heredocs
were, so composition is byte-identical. Because they run as one spliced module,
the bridge can't be `import`ed cleanly; `tests/test_bridge_origin.mjs` therefore
regex-extracts `isCanvasOrigin`/`LOOPBACK_HOSTS` out of `lib/glimpse-bridge.mjs`.

### Path resolution & shipping

`_lib_file <name>` resolves a lib file in this order: this checkout's `lib/`,
then `$GLIMPSE_DIR/<name>`, then `~/.glimpse/<name>` — so it works from any cwd
and after install (where `$SELF_DIR/../lib` does not exist). Any new lib file
must be added to **all three** of `install.sh` (the copy loop into
`$GLIMPSE_DIR`), `scripts/dev-link.sh` (the `ASSETS` array), and its `_lib_file`
call in `bin/glimpse`, or an installed `glimpse` won't find it.

Env/arg passing into the extracted scripts is unchanged: inline `VAR=… python3
"$f" …` exports to the (external) `python3` exactly as the old inline heredoc did.

## `glimpse ask --form` — declarative decision forms

`glimpse ask <slug> <title> [spec.json] --form` renders a small JSON spec into
an artifact of **native, accessible controls** (radio group / checkbox group /
select / text / textarea), blocks until the human submits, and prints the
structured choice as `{"slug","value"}` — the author writes no HTML and wires no
return plumbing. Without `--form`, `ask` is unchanged (the file is raw HTML).

The spec is validated + rendered by `lib/glimpse_ask.py` (mirrors
`glimpse_explain.py`: exit `2` on any spec-content error, publishing nothing;
`1` stays reserved for the verb's own failures). Shape:

```jsonc
{
  "prompt": "Approve the migration?",     // optional; in-page <h1> (defaults to <title>)
  "intro":  "One line of context.",       // optional supporting paragraph
  "submitLabel": "Send decision",         // optional; button text (default "Submit")
  "fields": [                             // required, non-empty (≤50)
    { "type": "radio",    "name": "decision", "label": "Decision", "required": true,
      "options": [ {"value":"approve","label":"Approve","selected":true},
                   {"value":"reject","label":"Reject"} ] },   // → value string (null if none)
    { "type": "checkbox", "name": "flags", "label": "Options", "help": "pick any",
      "options": [ {"value":"backup","label":"Snapshot first"} ] },  // → array of values
    { "type": "select",   "name": "batch", "required": true,
      "options": [ {"value":"500"}, {"value":"1000","label":"1,000"} ] },  // → value string
    { "type": "text",     "name": "note", "placeholder": "e.g. after 6pm" }, // → string
    { "type": "textarea", "name": "details" }                               // → string
  ]
}
```

`name` (per field) is the key in the returned `value` object and must match
`[A-Za-z0-9_-]{1,64}`, unique across fields. `options` is required (and
forbidden on text/textarea) for the three choice types; option `value`s must be
unique non-empty strings. See `examples/ask-form.json`.

**Sharp edges baked into the renderer — do not regress:**

- **The canvas iframe is `sandbox="allow-scripts"` with NO `allow-forms`,** so a
  real `<form>` submission (and the `submit` event) is *blocked by the sandbox*.
  The renderer therefore drives off the submit **button's `click`** (a
  `type="button"`, never a real submit) → `glimpseSubmit()` → the existing
  `glimpseRespond()` postMessage. Never switch it back to a form-`submit`
  listener or `<button type="submit">` — it will silently never fire in-canvas.
- **Custom radios/checkboxes** use `appearance:none` + CSS-drawn indicators so
  they read as **hollow when unselected / filled when selected in BOTH light and
  dark mode** (native radios render as filled black dots in light mode — the
  input-playbook design-review pitfall this exists to avoid). Both themes are
  driven by `prefers-color-scheme` CSS vars.
- **Validation:** native `required` (radio / select / text / textarea) is
  enforced via `form.reportValidity()` inside the click handler (works
  in-sandbox — it doesn't submit); "pick at least one" for a *required checkbox
  group* can't be expressed natively, so it uses a `data-min="1"` attribute on
  the `<fieldset>` checked in JS.
- **No spec data reaches JS/CSS** — the collector reads live DOM state and the
  script is an injection-free constant; every spec string is HTML-escaped into
  markup. Return rides the SAME `glimpse:response` channel `cmd_ask` already
  polls; no second channel.

## Tests

- `uv run --with pytest pytest tests/` — Python units
- `node --test tests/*.mjs tests/*.cjs` — renderer/bridge units (no deps)
- `bash tests/test_explain_cli.sh`, `bash tests/test_node_anchor.sh` — CLI smoke
- `GLIMPSE_RUNTIME_TESTS=1 bash tests/test_*_cdp.sh` / `test_node_roundtrip.sh` —
  live-CDP, opt-in (need a running `glimpse open`)
