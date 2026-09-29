# Code walkthrough v1 review

## Final design

The diagram occupies the full width. Source is initially hidden; node selection opens an inspector below. A horizontal pointer/keyboard divider adjusts their heights. Closing source restores the diagram. Native buttons, SVG connectors and stage lanes retain readable labels, distinct call/return paths, real diamond gates and light/dark tokens without a runtime graph dependency.

Logical blocks expose purpose, exact source and line numbers. Stack navigation derives from calls. Ask reveals its composer in the code panel and preserves the captured node/frame/block/version as the reader navigates. Saved questions show their target; replies stay anchored to their node. Reconnect copies instructions for the active coding agent, with explicit lease and source-evidence contracts.

## Crew review

Six independent roles reviewed the implementation before merge: product, engineering, security, adversarial QA, design and developer experience. The root implementer applied all material findings; security, QA and design subsequently passed their rechecks. Engineering and DX requested the small follow-up fixes below, now implemented and regression-tested or documented.

| Finding | Resolution |
| --- | --- |
| Entire files exposed in page HTML | Private snapshot retains files; public page contains only selected blocks and hashes; detected public secrets fail generation |
| Old answerer could reply after replacement | Active lease checked while holding session then thread locks |
| Clear disabled context validation | Binding remains authoritative and public metadata survives clear |
| macOS uppercase private path bypass | Lexical and resolved private path checks are case insensitive; alias regression added |
| Object-property node IDs broke replay | Null-prototype grouping; replay/clear regression |
| Generic highlight Ask lacked block targets | Walkthrough advertises block-only Ask while retaining reply replay |
| Excessive context and missing earlier answers | Outline plus targeted block/caller and bounded node conversation; related source on demand |
| Historical evidence labelled current | Verification time, hash and page-version relationship are visible |
| Invisible Ask composer | Explicit Ask scrolls only the source panel |
| Hidden edge labels and unclear gate | Separate edge routing bands and SVG diamond |
| Missing block purpose and history target | Compact purpose, persisted target labels and node reply counts |
| Installed symlink silently skipped CLI | Canonical CLI entry path; real installed HTML/JSON regression |
| Internal stack on expected poll expiry | Concise reconnect error with cleanup |
| Installed skill had a dead relative link | Link points to repository documentation |

## Verification

- Full Node suite: 209 tests, 207 passed, 2 existing runtime skips, zero failures.
- All bash smoke tests passed; external-browser and public-host tests remain explicitly opt-in.
- Shell syntax, warning-level shellcheck and diff whitespace checks passed.
- Node coverage: generator 98.70% lines / 78.90% branches; context 92.16% lines / 80.46% branches. These are Node-run measurements, not a claim of full browser coverage. Browser-renderer code is checked separately below.
- Real isolated Chrome/Glimpse: all four example nodes, every stack entry, seven blocks against real source, hidden initial code/no load scroll, full-width diagram with inspector, visible Ask, keyboard splitter, contained horizontal scrolling, and light/dark rendering. No runtime exceptions during these interactions.
- Real Ask round trip: block question → canvas acknowledgement → durable poll delivery → repository context → evidence from a file outside initial frames → session-owned answer → node reply. Draft cleared after durable replay.
- Real reconnect: a saved unanswered question already delivered to one session was recovered by a new session. Controlled source change in a temporary repository produced the browser warning while preserving the page snapshot.
- Repeat browser checks with `GLIMPSE_CDP_PORT=<isolated-port> node tests/cdp_assert_walkthrough.mjs` after opening a fresh example artifact in an isolated canvas. This deliberately does not run against a user's canvas during ordinary CI.

V1 is source-inferred and requires an agent-authored scenario. It does not prove semantic correctness, record execution, discover a whole repository graph, or start an agent automatically. Existing published pages were not rewritten.
