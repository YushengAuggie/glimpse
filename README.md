# 👁 Glimpse

**A live visual canvas for AI coding agents.** Your agent publishes
self-contained HTML — diagrams, tables, tabbed deep-dives, interactive demos —
to a local dashboard you watch update in a real Chrome window. No more reading
walls of terminal text.

Glimpse drives Chrome over the **Chrome DevTools Protocol (CDP)**, so the same
setup also lets your agent *read* and *control* real web pages.

```
┌─ localhost:4321 (Chrome) ────────────────────────────┐
│  👁 Glimpse                            [● auto-reload]│
│ ┌──────────┬────────────────────────────────────────┐│
│ │ Artifacts│  Design a Job Scheduler                 ││
│ │ • Job Sch│  ▸ Overview                             ││
│ │ • Research  ▾ Architecture   [live mermaid diagram]││
│ │ • Diff   │  ▸ Deep dives (tabs)                    ││
│ └──────────┴────────────────────────────────────────┘│
└───────────────────────────────────────────────────────┘
```

---

## Why this exists — the design idea

Coding agents produce a lot of output that is *miserable* to read in a terminal:
long tables, architecture diagrams, multi-section reports, before/after diffs.
Markdown in a TTY can't draw a diagram, can't collapse a section, can't show a
tab. So the agent either dumps everything (overwhelming) or summarizes (lossy).

Glimpse fixes the **rendering surface**, not the model. Three ideas:

1. **HTML is the richest format an agent already knows how to write.** Let it
   emit a full HTML page per "thing it wants to show you" — then render that in
   a real browser where diagrams, tabs, collapsibles, and JS just work.
2. **A real browser you already trust.** Instead of a bespoke GUI, Glimpse uses
   **Chrome over CDP**. The same channel that renders artifacts also lets the
   agent navigate, read, and screenshot live pages — one capability, two uses.
3. **Live, append-only, zero-friction.** The agent runs one command; the
   dashboard polls a feed and opens new artifacts automatically. You never
   refresh, never copy-paste, never leave your editor's neighbor window.

The result is a **shared screen between you and your agent**: it shows, you
watch, both in real time.

### How it works (architecture)

```mermaid
flowchart LR
  A[AI agent] -->|glimpse publish| F[(feed.json + artifacts/*.html)]
  S[static server :4321] --- F
  D[Glimpse dashboard\nindex.html] -->|polls feed every 1.2s| S
  D -->|iframe| ART[artifact HTML]
  A -->|glimpse open / CDP| C[Chrome :9222]
  C --> D
```

- **`glimpse publish`** writes `artifacts/<slug>.html` and upserts `feed.json`.
- A tiny **static server** (`python3 -m http.server`) serves the canvas dir.
- **`index.html`** polls `feed.json` and renders the newest artifact in an
  `<iframe>` (full JS/CSS isolation), live-reloading on change.
- **Chrome** is launched with `--remote-debugging-port` so the agent can open
  the canvas — and read/drive any other page — over CDP.

No framework, no build step, no database. ~1 HTML file + 1 shell script.

---

## How people use it

- **System design / interview prep** — render a question breakdown with a
  mermaid architecture diagram and tabbed deep-dives (see `examples/`).
- **Research reports** — long, cited findings as a scrollable, sectioned page
  instead of a 3-screen terminal dump.
- **Code review & diffs** — before/after panels, risk callouts, file trees.
- **Dashboards** — the agent polls something (CI, metrics) and re-publishes the
  same slug; the canvas updates in place.
- **Web reading/automation** — `glimpse read <url>` pulls page text; with the
  chrome-devtools MCP server the agent can click and fill forms too.
- **Pairing with notes** — keep the interactive view in Glimpse and a durable
  Markdown copy in Obsidian/your notes app.

---

## Setup

### Requirements
- **Node.js** (built-in WebSocket — Node 18+; tested on 22) — drives Chrome
- **Python 3** — the static server
- **Google Chrome** (or Chromium) — the canvas window + CDP

### Install
```bash
git clone https://github.com/YOURNAME/glimpse.git
cd glimpse
./install.sh            # CLI → ~/.local/bin, canvas → ~/.glimpse, agent skills → ~/.claude/skills
```

Flags: `./install.sh --no-skills`, or `./install.sh --mcp claude` /
`--mcp codex` to also register the [chrome-devtools MCP server](https://github.com/ChromeDevTools/chrome-devtools-mcp)
so MCP-capable agents get first-class browser tools.

Check everything:
```bash
glimpse doctor
```

### Use it
```bash
glimpse open                                   # opens the canvas in Chrome
glimpse publish hello "Hello" examples/job-scheduler.html
```
You should see the artifact appear in the sidebar instantly.

---

## Agent integration

Glimpse ships two **skills** (for Claude Code / compatible agents) so you never
type the plumbing — just talk:

| Skill | Trigger | What it does |
|---|---|---|
| `canvas` | "show this on the canvas", "/canvas" | publish rich output to Glimpse |
| `chrome-cdp` | "use chrome", "read this page" | drive a real Chrome over CDP |

Under the hood both call the `glimpse` CLI. For other agents, just teach them
the three commands: `glimpse open`, `glimpse publish`, `glimpse read`.

---

## CLI reference

```
glimpse open [url|#slug]              serve + launch Chrome + navigate to the canvas
glimpse publish <slug> <title> [file] publish an HTML artifact (reads stdin if no file)
glimpse serve                        start the static server only
glimpse chrome                       launch a debuggable Chrome only
glimpse read <url>                   navigate Chrome to a URL and print its text
glimpse shot <out.png> [url]         screenshot the current (or given) page
glimpse doctor                       check dependencies and running state
```

Config via env: `GLIMPSE_DIR`, `GLIMPSE_PORT` (4321), `GLIMPSE_CDP_PORT`
(9222), `GLIMPSE_PROFILE`, `GLIMPSE_CHROME`.

---

## Security

The CDP Chrome uses a **dedicated profile** — it does *not* see your everyday
browser's logins or tabs. Anything you load into that window, the agent can
read and control. Only log into accounts there that you're comfortable letting
your agent act on. See [`docs/DESIGN.md`](docs/DESIGN.md) for the threat model.

## Docs
- [`docs/DESIGN.md`](docs/DESIGN.md) — design rationale, alternatives, threat model
- [`docs/USAGE.md`](docs/USAGE.md) — the full flow with examples

## License
MIT
