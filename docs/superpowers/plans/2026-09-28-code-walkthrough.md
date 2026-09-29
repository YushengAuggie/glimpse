# Code Walkthrough Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans task by task. The user authorized autonomous implementation, push and merge after crew review. Do not add approval gates for routine implementation.

**Goal:** Ship one reusable, source-grounded walkthrough generator with graph-first reading, block-local questions and manual coding-agent reconnection.

**Architecture:** A validated snapshot contains scenario, frames, logical blocks and flow nodes. A separate local context binding resolves current repository evidence and session ownership. Generated HTML inlines a reusable renderer and style; existing annotate/thread/poll transport carries questions, state and replies.

**Tech Stack:** Node22 standard library, bash dispatcher, vanilla browser JS/CSS/SVG, existing Glimpse thread store and CDP verification.

**Spec:** `.lavish/code-walkthrough-design/design.md` plus final `review.html` and `final-design-notes.md`. Latest user clarification: diagram full width, code inspector below only after node selection; horizontal height divider. Designer's final computed appearance is a reference, not the accumulated prototype CSS implementation.

## Global Constraints

- Keep existing explain/publish pages and legacy thread contracts compatible; no migration or overwrite of existing artifacts.
- No Python runtime, build pipeline, model-provider integration or external code-upload service.
- Read actual files, retain relative paths/ranges/hashes, escape embedded JSON and text. A citation verifies source bytes, not model reasoning.
- Repo reads stay within realpath-confirmed binding; source changes show a warning, never rewrite the saved page automatically.
- Manual active-agent connection; no background launcher. Canvas receipt differs from durable save. Saved unanswered turns recover across restart, drafts do not claim restart durability.
- Implementer works on existing feature branch, preserves pre-existing untracked docs. Commit only scoped files. User now explicitly authorizes commit/push/merge after checks and crew review.
- Use first-version tree-shaped frame call paths; reject cycles or ambiguous parents explicitly rather than inventing a stack.

## Review Focus

- A valid-looking citation with stale bytes must not be published as verified current evidence.
- A delivered but unanswered question must recover when a new session reconnects.
- Selecting another node while composing must not retarget the question or steal its draft.
- Private repo binding/session data must not become accessible via the static server or portable artifact.
- Full-width diagrams and source lines must remain usable in the actual narrow canvas iframe in both themes.

## Task 1: Snapshot engine and source contract

Files: new `lib/glimpse-walkthrough.mjs`, `tests/test_walkthrough.mjs`, example scenario spec.

Interfaces: `buildSnapshot(spec, repo)` returns `{version:1, revision, title, scenario, prose_language, frames, nodes, edges, stages, files}`; files map relative paths to `{hash, raw}`. Frame has `id,name,file,purpose,blocks,calls`; block has stable `id,title,purpose,start,end,raw,htmlLines`; calls maps child frame ID to caller block index. Nodes have `id,kind,stage,label,frame,blocks,purpose,happens,io,remember,gate?,reason?,example?`. Examples carry `kind` and `provenance`. `wrapArtifact(snapshot,slug)` returns self-contained HTML. All node IDs receive a DOM prefix.

- [x] Write and run failing tests for real source extraction/range accuracy, hostile embedded text, invalid ranges, symlink/path escapes, cycles/multiple parents, bad block indexes and unlabelled examples.
- [x] Implement validation/extraction/hash and derived stack helpers, bounded inputs, and safe inline snapshot serialization.
- [x] Run targeted tests; no external highlighter dependency, reuse existing safe tokenization where practical.

## Task 2: Context, reconnect and grounded replies

Files: new `lib/glimpse-walkthrough-context.mjs`, tests; targeted changes to threads, poll, bridge and server.

Interfaces: private `.walkthrough/<slug>/` holds snapshot+repo binding+session; public thread metadata holds only `{revision,expiresAt,changedFiles,state}`. CLI `walkthrough connect <slug>` returns session and reconstructed pending context; `context <slug> [turn-id]`, `evidence <slug> <relative-file> <start> <end>` return versioned source records; `heartbeat/disconnect <slug> <session>` own the lease. `reply <slug> <turn> <answer.json> --session <session>` validates `{claims:[{kind:'source'|'inference'|'unknown',text,evidence:[{file,start,end,hash}]}]}` and persists resolved excerpts with the reply. Source/inference claims require evidence; unknown may omit it.

- [x] Fail tests for private binding access, forged/stale citations, escaped source paths, same-turn reply routing and restoration of delivered-but-pending questions.
- [x] Implement context resolver from stored IDs, current source checks and parent callsite; never depend on scraped page text. Related files are read on demand within the bound root.
- [x] Implement a single expiring session and heartbeat. `glimpse poll --walkthrough <slug> --session <id>` filters feedback, keeps the lease alive while waiting, and does not lose pending recovery on reconnect. Daemon skips bound walkthrough questions.
- [x] Preserve frame/block/revision metadata through thread persistence. Validate walkthrough answers before writing, secret-scrub all persisted text and evidence.
- [x] Send public connection metadata with existing thread replay. Deny static-server reads of the private binding directory including symlink aliases.
- [x] Run targeted context/thread/poll/server regression tests.

## Task 3: Reusable diagram and code inspector

Files: new `canvas/glimpse-walkthrough.js`, `.css`, renderer behavior tests.

Consumes snapshot and existing `window.__GLIMPSE__` channel. Registers `__GLIMPSE_EXPLAIN__.mountNodeReply` before annotate loads. Graph layout is derived from stages/nodes/edges, not hard-coded Glimpse example positions. UI follows approved full-width graph, bottom inspector, semantic colors and engineering shapes. Code lines come only from extracted source.

- [x] Write failing behavior tests for node/frame/block selection, stack caller block derivation, stable Ask target, parent/channel filtering, late config, ACK vs durable replay, draft dedup and expired connection.
- [x] Build readable generic graph with source-inferred label, stage responsibilities, numbered scenario route and attached untaken branches. Add native accessible node navigation and code-block Ask.
- [x] Implement horizontal height splitter (pointer+Up/Down keys), themes, non-contiguous gaps, compact explanations/examples, evidence excerpts and reconnect-copy guidance. No initial source-panel auto-scroll.
- [x] Wire real annotate send and replay; Send requires a valid active session. Unsent text remains recoverable in current page, pending ID reused on retry, replies do not steal focus.
- [x] Verify renderer behavior tests and browser render in both themes.

## Task 4: CLI, shipping and agent workflow

Files: `bin/glimpse`, `install.sh`, `scripts/dev-link.sh`, `skills/explain/SKILL.md`, README/docs, CLI tests.

CLI build: `glimpse walkthrough <slug> <title> <spec.json> --repo <path>` validates, generates self-contained HTML and publishes locally using existing publish machinery. Subcommands above support manual reconnect; copy guidance asks coding agent to connect, restore context, inspect evidence, reply and poll. No model/API key needed: the active coding agent answers.

- [x] Fail CLI tests for invalid build publishing nothing, successful installed asset lookup, existing-slug protection and saved binding/reconnect behavior.
- [x] Add pure bash dispatcher entry and ship all new assets through install/dev-link/seed conventions. Document actual commands only and evidence limits.
- [x] Add source-authored example based on real Glimpse flow, with labelled scenario input. Keep old examples/artifacts intact.
- [x] Run full Node suite, bash smoke suite, syntax and shell lint; inspect diff and collect changed-module coverage.

## Task 5: Real-browser validation, crew and merge

- [x] Use an isolated Glimpse data root for testing; publish a new unique sample slug. Browser-check light/dark, all nodes and callers, bottom inspector resizing and 5 real line ranges.
- [x] Execute real canvas question→ACK→disk save→active-agent evidence answer→node reply. Ask one question needing a file outside initial frames. Reconnect after losing session with an unanswered saved turn and verify recovery. Check stale source warning, wrong channel, no console errors.
- [x] Run crew roles (product, engineering/architecture, security, adversarial QA, UI, DX) in capacity-limited waves; reviewers read scoped diff, spec, test results and browser evidence. Fix material findings and recheck affected tests.
- [ ] Commit only intended implementation/design/plan files, push feature branch, open PR with concise outcome+validation, wait for CI, merge without altering unrelated files, verify remote main and report first version for review.

## Execution ledger

- Design approved via final Lavish feedback; session ended, never reopen without request.
- Ruling: use the existing feature branch in place. No new worktree or blanket cleanup; preserve untracked pre-existing docs. Root implements; designer only polished the isolated artifact. User explicitly requests autonomous commit/push/merge.
- Ruling: reject ambiguous call graphs for v1. Dynamic dispatch/source-inferred execution remains labelled and never claimed observed.
- Pre-flight: snapshot contract feeds renderer+context; thread anchor carries stable snapshot/block IDs; public connection state travels via existing replay. Private session token never travels to artifact.

- Implementation and review evidence: [Code walkthrough v1 review](../../reviews/2026-09-29-code-walkthrough.md). CLI integration tests were added alongside implementation; generator/context/renderer and critical review regressions were exercised failing before their fixes. No claim that every CLI check followed strict TDD.
