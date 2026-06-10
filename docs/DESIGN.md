# Glimpse — design notes

## The problem
AI coding agents are great writers and terrible presenters. Their richest
thinking — architectures, comparisons, trade-off tables, staged plans — arrives
as Markdown in a terminal that can't render a diagram, collapse a section, or
show a tab. The agent is forced to choose between **dumping** (overwhelming) and
**summarizing** (lossy). Neither is how a human colleague would show you their
work; they'd open a doc or sketch on a whiteboard.

## The bet
Don't change the model — change the **surface**. An agent already knows how to
write a complete, self-contained HTML page. If we render that page in a real
browser, we get diagrams, tabs, collapsibles, syntax highlighting, charts, and
live JS *for free*, with zero new model capability.

## Why Chrome over CDP (vs. alternatives)

| Approach | Why not |
|---|---|
| Custom Electron/Tauri viewer | A whole app to build, ship, update. Glimpse is one HTML file. |
| Markdown preview (e.g. an editor pane) | No interactivity, no JS, weak diagram support. |
| Hosted web app | Needs a server, auth, deploy. Glimpse is local + offline-friendly. |
| Terminal image protocols (kitty/iTerm) | Static images only; no interaction, no reflow. |

Chrome via the **Chrome DevTools Protocol** wins because:
- It's a browser everyone already has and trusts.
- The *same* channel that displays artifacts also lets the agent **navigate,
  read, and screenshot** real pages. One mechanism, two capabilities — the
  canvas and web automation share infrastructure.
- It's scriptable from any language; Node ships a built-in WebSocket so the
  driver is dependency-free.

## Key design choices

- **Append-only feed, not a protocol.** Publishing is just "write a file + add a
  line to `feed.json`." The dashboard polls. This is trivially debuggable
  (it's files on disk) and resilient (a crashed agent leaves a valid canvas).
- **Artifacts are isolated in an `<iframe>`.** Each artifact brings its own
  CSS/JS and can't break the shell or its siblings. The agent can use any CDN
  (mermaid, chart libs) without coordination.
- **Polling over websockets/live-reload servers.** A 1.2s poll of a static JSON
  file needs no server logic, no socket lifecycle, no reconnect handling. The
  static server is literally `python3 -m http.server`.
- **Cache-busting by timestamp.** Re-publishing the same slug bumps its `ts`,
  which changes the iframe `src`, which forces a reload — so "update in place"
  works without any diffing.
- **Dedicated Chrome profile.** Chrome 136+ blocks remote debugging on the
  default profile (anti-cookie-theft). Glimpse embraces that: a separate
  profile is both required and safer.

## Threat model / security
- The agent can read and control **everything in the CDP Chrome window**. Treat
  that profile as "agent-accessible." Don't log into accounts there you wouldn't
  let the agent use.
- The CDP port (`9222`) is bound to localhost. Anyone who can run code as your
  user can reach it — same trust boundary as your shell.
- Artifacts are local HTML opened from `localhost`; they can call out to the
  network (e.g. CDN scripts). If you care, audit artifacts or run offline.
- Glimpse never touches your real/default Chrome profile.

## Non-goals
- Not a notebook, not a BI tool, not a replacement for your editor.
- Not multi-user or hosted. It's a personal, local agent↔human screen.

## Possible extensions
- A `glimpse watch` that re-publishes an artifact when a source file changes.
- Export an artifact to a standalone HTML/PDF for sharing.
- A "pin" UI in the shell to stop auto-jumping to the newest artifact.
- Optional websocket push for sub-second updates on dashboards.
