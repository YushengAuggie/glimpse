# Playbook · diagram

**Use when** the relationship is the point: a request flow, a system
architecture, a state machine, a dependency graph, a sequence of calls. Anything
you'd otherwise describe as "A sends X to B, which…" is clearer drawn.

**Don't** reach for a diagram when there's no topology — a list of steps with no
branching is a numbered list, and tabular data is a [table](table.md).

## Choose the technique

- **Mermaid** (default) when automatic node placement and edge routing matter
  more than rich node content — flows, sequences, state, ER, class diagrams. This
  is the precedent in `examples/architecture-overview.html`; the canvas Chrome has
  internet, so the CDN script is fine.
- **CSS grid / positioned HTML / SVG** when each node needs prose, code, a
  control, or heavy annotation — Mermaid nodes are cramped for that.
- **Hybrid** for big systems: one small Mermaid overview, then detailed HTML
  cards below it. Don't cram every file into one graph.

## Recipe

1. Lead with the **question the diagram answers** ("How does an upload become a
   thumbnail?"), not "here is the architecture."
2. Keep the first visual to the **core relationship**; push dense evidence (file
   refs, endpoint tables, ops notes) into cards below it.
3. Prefer **top-down** (`TB`) for multi-step flows unless the flow is genuinely
   short and linear (`LR`).
4. Use page-scoped class names — Mermaid owns generic ones like `.node`.
5. Label uncertain edges as questions so the reader can correct them.

## Light + dark (the Mermaid gotcha)

Mermaid bakes its theme **at `initialize()`** and won't restyle on a CSS theme
flip. Wire it to the toggle: stash each graph's source, and on theme change
re-`initialize` with the right theme then re-`run`. Use `theme:'neutral'` for
light and `theme:'dark'` for dark — both read well against the page. Give
`.diagram` `overflow:auto` so a wide graph scrolls instead of bleeding.

## Snippet

```html
<div class="card bleed">
  <div class="eyebrow">Flow · upload → thumbnail</div>
  <h2>How does an upload become a thumbnail?</h2>
  <div class="diagram" style="overflow:auto"><pre class="mermaid">
flowchart TB
  U([Client]) -->|upload| API[Upload API]
  API -->|store original| S3[(Object store)]
  API -->|enqueue| Q[[Queue]]
  Q --> W[Resizer worker]
  W -->|write sizes| S3
  S3 --> CDN[(CDN)] --> U
  </pre></div>
</div>

<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>
  // Keep the source so we can re-render when the theme flips.
  document.querySelectorAll('.mermaid').forEach(n => n.dataset.src = n.textContent);
  function renderMermaid(mode){
    document.querySelectorAll('.mermaid').forEach(n => {
      n.removeAttribute('data-processed'); n.textContent = n.dataset.src;
    });
    mermaid.initialize({ startOnLoad:false, theme: mode === 'dark' ? 'dark' : 'neutral' });
    mermaid.run();
  }
  // base.html calls this on every theme change; also run once on load.
  window.__onThemeChange = renderMermaid;
  renderMermaid(document.documentElement.getAttribute('data-theme') === 'dark'
    || (document.documentElement.getAttribute('data-theme') !== 'light'
        && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light');
</script>
```

**Pitfalls:** don't hand-build boxes-and-arrows from `<div>`s for a flow (no edge
routing, reads worse than Mermaid); don't let default diagram colors clash with
the page or become invisible in one mode; don't present unverified architecture
as fact — cite the files that back it.

Worked example: [`examples/playbooks/diagram.html`](../../../examples/playbooks/diagram.html).
