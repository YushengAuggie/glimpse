# Glimpse — usage & flow

## The everyday flow

```mermaid
sequenceDiagram
  participant You
  participant Agent
  participant Glimpse as glimpse CLI
  participant Chrome
  You->>Agent: "show me X on the canvas"
  Agent->>Glimpse: glimpse open
  Glimpse->>Chrome: launch (CDP) + navigate to localhost:4321
  Agent->>Agent: write /tmp/x.html (self-contained)
  Agent->>Glimpse: glimpse publish x "Title" /tmp/x.html
  Glimpse-->>Chrome: feed.json changes → dashboard auto-opens it
  You->>You: read it in the Chrome window
```

You typically only ever say *"put it on the canvas."* The agent does the rest.

## First run

```bash
glimpse doctor     # confirm node / python3 / chrome are found
glimpse open       # opens the empty canvas in Chrome
```

Publish the bundled example to see a real artifact:

```bash
glimpse publish job-scheduler "Design a Job Scheduler" examples/job-scheduler.html
```

It should appear in the sidebar within ~1 second and open automatically.

## Writing a good artifact

An artifact is **one self-contained HTML file**. Guidelines:

- Inline your CSS and JS. CDN `<script>` tags are fine (the Chrome has
  internet) — e.g. mermaid:
  ```html
  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
  <script>mermaid.initialize({startOnLoad:true, theme:'neutral'});</script>
  <pre class="mermaid">flowchart LR; A-->B</pre>
  ```
- Keep content ~860px wide; it renders inside an iframe.
- Great building blocks: `<details>` collapsibles, a tab strip (a few buttons +
  show/hide panels), `<table>`, callout boxes.
- A light theme inside the artifact reads cleanly against the dark shell.

Verify it rendered (useful for agents):
```bash
glimpse shot /tmp/check.png        # screenshot the current canvas page
```

## Updating in place

Re-publishing the **same slug** replaces the artifact and live-reloads the open
view — perfect for dashboards:

```bash
while true; do
  build-status-html > /tmp/ci.html
  glimpse publish ci "CI status" /tmp/ci.html
  sleep 30
done
```

## Reading & driving the web

```bash
glimpse read https://example.com         # prints {title, url, text}
glimpse shot /tmp/page.png https://...    # navigate + screenshot
```

For full interaction (click, fill, network capture), register the
chrome-devtools MCP server (`./install.sh --mcp claude`) and use its tools.

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `GLIMPSE_DIR` | `~/.glimpse` | served root (index.html, artifacts/, feed.json) |
| `GLIMPSE_PORT` | `4321` | canvas http port |
| `GLIMPSE_CDP_PORT` | `9222` | Chrome remote-debugging port |
| `GLIMPSE_PROFILE` | `$GLIMPSE_DIR/chrome-profile` | dedicated Chrome profile |
| `GLIMPSE_CHROME` | auto-detect | path to the Chrome/Chromium binary |

## Troubleshooting

- **"chrome cdp: down"** in `glimpse doctor` → run `glimpse chrome`; if Chrome
  isn't found set `GLIMPSE_CHROME=/path/to/chrome`.
- **Nothing appears after publish** → confirm the server is up
  (`glimpse doctor`), and that you published a `.html` file.
- **Port already in use** → set `GLIMPSE_PORT` / `GLIMPSE_CDP_PORT`.
- **A site won't load logged-in** → log into it once in the Glimpse Chrome
  window; the dedicated profile persists across runs.
