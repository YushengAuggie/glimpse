# Glimpse tests

Python unit tests (no project config needed):

    uv run --with pytest pytest tests/ -v

Bash CLI smoke tests:

    bash tests/test_explain_cli.sh

Renderer unit tests (Node, no deps):

    node --test tests/test_explain_renderer.cjs

Renderer integration (needs `glimpse open` first):

    bash tests/test_explain_render_cdp.sh
