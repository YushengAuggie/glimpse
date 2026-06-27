# Glimpse tests

Python unit tests (no project config needed):

    uv run --with pytest pytest tests/ -v

Bash CLI smoke tests:

    bash tests/test_explain_cli.sh

Renderer unit tests (Node, no deps):

    node --test tests/test_explain_renderer.cjs

Renderer integration — live CDP, opt-in (needs a running `glimpse open` and
`GLIMPSE_RUNTIME_TESTS=1`; otherwise SKIPs so a `tests/*.sh` sweep never touches
an open canvas):

    GLIMPSE_RUNTIME_TESTS=1 bash tests/test_explain_render_cdp.sh   # renders a fixture + asserts the DOM
    GLIMPSE_RUNTIME_TESTS=1 bash tests/test_node_roundtrip.sh       # node ask → reply renders inline
