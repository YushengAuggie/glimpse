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

## Per-artifact keying — several artifacts (and agents) can be active at once

Every feedback / response / thread stream is **keyed per artifact by slug**, end to
end, so highlights or answers on artifact A never leak into B's stream and an agent can
address each independently. There is no global "the active artifact" state that carries
feedback — the slug is the key at every hop:

- **Storage (source of truth):** `threads/<slug>.json` — one exclusive-locked,
  atomic read-modify-write per artifact (`glimpse_threads.py`). `feed.json` holds one
  entry per slug. Two agents can `publish` / `reply` / `thread` different slugs
  concurrently without contention (per-slug `flock`); a turn id from A's thread cannot
  be answered inside B's (`add_agent` rejects a foreign `TO`).
- **Bridge (`glimpse-bridge.mjs`):** keeps a live CDP connection to **every** open
  canvas tab and routes each drained outbox message by its own `m.slug` — never by
  which tab is focused. Dedup (`seen`) and emit (`emitted`) sets are keyed by globally
  unique message / turn ids, so multiple tabs and multiple artifacts share them safely.
- **Canvas shell (`canvas/index.html`):** browser→agent buffers are keyed off the
  **iframe's own slug** (`f.dataset.slug`, stamped in `show()`), not the mutable
  `current`. `window.__glimpse_responses[slug]` (read by `glimpse ask`), each pushed
  `__glimpse_outbox` entry's `slug`, and `window.__glimpse_audit[slug]` (read by
  `glimpse audit`) are all per-slug. `__glimpse_audit` is a **per-slug map** (not one
  latest-buffer): viewing a second artifact no longer wipes the first's audit; `show()`
  clears only the shown slug's stale entry so it re-captures fresh.

The dashboard still renders **one artifact at a time** (the common single-artifact
experience is unchanged) — the keying is what lets more than one be live without
cross-talk. **When you touch any browser→agent buffer, key it by the sending iframe's
slug, never by `current`.** Multi-tab, multiple-agent audit-window selection in
`cmd_ask`/`cmd_audit` (which grab *a* canvas tab) is out of scope here; the buffers they
read are already per-slug.

## Tests

- `uv run --with pytest pytest tests/` — Python units (incl.
  `test_glimpse_threads_multi.py`: two artifacts keep separate threads / pending /
  replies, and clearing one leaves the other)
- `node --test tests/*.mjs tests/*.cjs` — renderer/bridge units (no deps)
- `bash tests/test_explain_cli.sh`, `bash tests/test_node_anchor.sh` — CLI smoke
- `GLIMPSE_RUNTIME_TESTS=1 bash tests/test_*_cdp.sh` / `test_node_roundtrip.sh` —
  live-CDP, opt-in (need a running `glimpse open`). `test_multi_artifact_cdp.sh` proves
  two artifacts' audits coexist in `__glimpse_audit` and their threads stay isolated.
