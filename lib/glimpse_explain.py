#!/usr/bin/env python3
"""Glimpse code-explainer engine: validate an explain spec and wrap it into an
artifact. Imported by tests and invoked as a CLI by `bin/glimpse`. Stdlib only."""

import json
import re
import sys

SCOPES = {"change", "feature", "repo"}
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MERMAID_RESERVED = {
    "end",
    "default",
    "graph",
    "flowchart",
    "subgraph",
    "classDef",
    "linkStyle",
    "style",
    "click",
}
SNIPPET_MAX_LINES = 200
SNIPPET_MAX_BYTES = 16 * 1024
SPEC_MAX_BYTES = 2 * 1024 * 1024


class SpecError(ValueError):
    """Raised on the first validation problem, with a human-readable message."""


def _check_ids(items, where):
    seen = set()
    for it in items:
        i = it.get("id") if isinstance(it, dict) else None
        if not isinstance(i, str) or not ID_RE.match(i):
            raise SpecError("%s: id %r must match [A-Za-z0-9_-]{1,64}" % (where, i))
        if i in MERMAID_RESERVED:
            raise SpecError("%s: id %r is a reserved word" % (where, i))
        if i in seen:
            raise SpecError("%s: duplicate id %r" % (where, i))
        seen.add(i)
    return seen


def validate(spec):
    """Validate a parsed spec dict. Return True or raise SpecError(msg)."""
    if not isinstance(spec, dict):
        raise SpecError("spec must be a JSON object")
    if spec.get("scope") not in SCOPES:
        raise SpecError("scope must be one of: change, feature, repo")
    if not isinstance(spec.get("title"), str) or not spec["title"].strip():
        raise SpecError("title is required")
    if not any(spec.get(k) for k in ("architecture", "dataflow", "callstack")):
        raise SpecError(
            "at least one of architecture/dataflow/callstack must be present"
        )

    arch = spec.get("architecture") or {}
    _check_ids(arch.get("components", []), "architecture.components")

    df = spec.get("dataflow") or {}
    df_ids = _check_ids(df.get("nodes", []), "dataflow.nodes")
    for e in df.get("edges", []):
        for end in ("from", "to"):
            if e.get(end) not in df_ids:
                raise SpecError(
                    "dataflow.edges: %s references unknown node %r" % (end, e.get(end))
                )

    cs = spec.get("callstack") or {}
    step_ids = _check_ids(cs.get("steps", []), "callstack.steps")
    if cs.get("steps"):
        if cs.get("entry") not in step_ids:
            raise SpecError(
                "callstack.entry %r is not a declared step" % cs.get("entry")
            )
        for st in cs["steps"]:
            for c in st.get("calls") or []:
                if c not in step_ids:
                    raise SpecError(
                        "callstack.steps[%s].calls references unknown step %r"
                        % (st.get("id"), c)
                    )
    return True
