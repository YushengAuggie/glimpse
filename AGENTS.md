# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Canvas authoring playbooks

When authoring an artifact to publish to the Glimpse canvas, agents follow a
structured playbook set — the friendliness/quality layer, analogous to the
review-artifact playbooks in sibling tooling.

- **Where they live:** `skills/canvas/playbooks/`. `README.md` is the router and
  holds the shared **design direction**, **light/dark theming**, and
  **portability/overflow** rules. One focused file per playbook: `diagram`,
  `table`, `plan`, `code`, `input`, `comparison`, `slides` — each a crisp
  *use-when* + *recipe* + copy-adaptable *snippet*. `base.html` is the
  copy-me starter that encodes the theme + toggle + overflow scaffolding.
- **Discovery:** `skills/canvas/SKILL.md` has a "Playbooks" section linking the
  set; the `explain` skill remains the path for dedicated code walkthroughs.
- **Worked examples:** `examples/playbooks/*.html` — one self-contained artifact
  per playbook. Light+dark screenshots at `examples/screenshots/<name>-{light,dark}.png`.

### Design bar for playbook artifacts (must hold)
1. Modern, editorial developer-tool look; indigo accent; **monospace eyebrow**
   labels are the signature. Match the existing `examples/` house style.
2. **First-class light AND dark mode.** Tokens on `:root` (light), overridden
   under both `@media (prefers-color-scheme: dark)` and `:root[data-theme="dark"]`
   so an explicit toggle beats the OS. Mermaid bakes its theme at `initialize()` —
   re-initialize + re-run on theme change (see `diagram.html`).
3. **No horizontal overflow at any nesting level:** flex/grid children need
   `min-width:0`, tracks use `minmax(min(240px,100%),1fr)`; long tokens/URLs/paths
   `overflow-wrap:anywhere`; tables in `.table-wrap{overflow-x:auto}`;
   `pre{overflow:auto;max-width:100%}`.
4. **Portable:** self-contained, inline CSS/JS, no build step; opens identically
   from disk. CDN (Mermaid) is fine — the canvas Chrome has internet.

### Verifying artifact rendering
Local files render/screenshot via `chrome-devtools-axi`: `newpage file://…`,
`resize 1440 900`, then `selectpage <id>` (resize deselects the page), set the
theme with `eval "() => { document.documentElement.setAttribute('data-theme','dark');
window.__onThemeChange && window.__onThemeChange('dark') }"`, `screenshot <abspath>`
(use an **absolute** path — relative paths write to the bridge's cwd, not yours).
`glimpse shot` is the alternative when the canvas is up.

**Scope guard:** playbooks are authoring guidance only. Do not encode runtime
behavior — the CLI verbs live in `bin/glimpse` and must not be invented in docs.
