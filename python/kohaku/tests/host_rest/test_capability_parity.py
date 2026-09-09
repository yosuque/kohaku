"""Regression test that the REST surface and the MCP surface issue identical capability scopes for the same Spec.

Both hosts are consolidated to consume the spec-layer collect_capability_scopes (no rule duplication). This pins that
the issuance rules do not drift between the two profiles (corresponding to the single-source-of-truth for issuance
rules in TS's capability-scopes.ts).
"""

from __future__ import annotations

import asyncio
from typing import Any

from kohaku.host_core import issue_capability_for_spec as host_core_issue_capability_for_spec
from kohaku.host_mcp.server import _issue_capability
from kohaku.host_rest._fastapi_routes import issue_capability_for_spec
from kohaku.spec import (
    IntentInput,
    Principal,
    UISpec,
    collect_capability_scopes,
    finalize_intent,
)

from .conftest import build_harness


def _mixed_spec() -> UISpec:
    """A Spec that declares both read (bind variant) and write (action.invoke)."""
    intent = finalize_intent(IntentInput(canonical="sales.trend", params={}))
    data: dict[str, Any] = {
        "kohaku": "0.2",
        "intent": intent.to_wire(),
        "dataVersion": "x",
        "state": {"region": "us"},
        "components": [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["c", "f"]},
            {
                "id": "c",
                "type": "presentChart",
                "props": {"kind": "line", "x": "month", "y": "revenue"},
                "data": {
                    "$ref": "query://sales/trend?granularity=month&metric=revenue&region=us",
                    "bind": {"region": {"$state": "region", "values": ["us", "eu", "jp"]}},
                },
            },
            {"id": "f", "type": "presentForm", "props": {"action": "annotate"}},
        ],
        "events": [{"on": "f.submit", "emit": "action.invoke", "payload": {}}],
        "provenance": {"tier": "L0", "composedBy": "test", "cache": "miss"},
    }
    return UISpec.model_validate(data)


def test_rest_and_mcp_issue_identical_scopes(tmp_path: Any) -> None:
    harness = build_harness(tmp_path)
    spec = _mixed_spec()
    principal = Principal(id="tester", roles=["user"])

    async def run() -> None:
        # Route the REST surface and the MCP surface through the same authz (which records scopes) and compare the issued scopes.
        # FakeDomain (conftest.py) lists "annotate" among its operations, so nothing is dropped here.
        rest_token = await issue_capability_for_spec(
            spec, principal, harness.deps, "compose", "test-request-id"
        )
        mcp_token = await _issue_capability(spec, principal, harness.authz)
        _, rest_scopes = harness.authz._tokens[rest_token]
        _, mcp_scopes = harness.authz._tokens[mcp_token]
        assert rest_scopes == mcp_scopes
        assert rest_scopes == collect_capability_scopes(spec)

    asyncio.run(run())


def test_rest_and_mcp_drop_the_same_write_scope_with_allowed_actions(tmp_path: Any) -> None:
    """Both profiles delegate write-scope filtering to the same kohaku.host_core.issue_capability_for_spec
    (the REST and MCP wrappers only differ in how they compute the allowed set), so passing the same
    allowed_actions to both must drop the same scope and issue identical remaining scopes.
    """
    harness = build_harness(tmp_path)
    spec = _mixed_spec()
    principal = Principal(id="tester", roles=["user"])
    allowed_actions: frozenset[str] = frozenset()  # "annotate" is not allowed -> its write scope is dropped

    async def run() -> None:
        rest_dropped: list[str] = []
        mcp_dropped: list[str] = []
        rest_token = await host_core_issue_capability_for_spec(
            harness.authz,
            principal,
            spec,
            allowed_actions=allowed_actions,
            on_dropped_action=rest_dropped.append,
        )
        mcp_token = await _issue_capability(
            spec,
            principal,
            harness.authz,
            allowed_actions=allowed_actions,
            on_dropped_action=mcp_dropped.append,
        )
        _, rest_scopes = harness.authz._tokens[rest_token]
        _, mcp_scopes = harness.authz._tokens[mcp_token]
        assert rest_scopes == mcp_scopes
        assert all(s.kind != "write" for s in rest_scopes)
        assert rest_dropped == mcp_dropped == ["annotate"]

    asyncio.run(run())
