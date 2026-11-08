"""Port of the MCP tests added by wp-o1 in packages/host-mcp-apps/test/mcp.test.ts: the eager bind-variant
preresolution cap, and L1 filter injection (ComposePolicy.l1Filters) over MCP."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from kohaku.composer import ComposeContext, ComposePolicy
from kohaku.host_mcp import CAPABILITY_META_KEY, INITIAL_DATA_META_KEY, AttachOptions, McpHostDeps
from kohaku.llm import FakeLlm
from kohaku.spec import FilterDescriptor, FilterOption, Intent, UISpec

from ._helpers import (
    CATALOG,
    DATA,
    RENDERER_HTML_PLAIN,
    SimpleAuthz,
    TrendDomain,
    _Semantic,
    connect,
    make_compose_ctx,
)

_OPTIONS = AttachOptions(renderer_html=RENDERER_HTML_PLAIN)
_WIDE_VALUES = [f"r{i}" for i in range(40)]
_WIDE_REF = "query://sales/trend?granularity=month&metric=revenue&region=r0"


def _wide_bind_spec(intent: Intent, handles: Any) -> UISpec:
    return UISpec.model_validate(
        {
            "kohaku": "0.2",
            "intent": intent.to_wire(),
            "dataVersion": "x",
            "state": {"region": "r0"},
            "components": [
                {"id": "root", "type": "layout.stack", "props": {}, "children": ["c"]},
                {
                    "id": "c",
                    "type": "presentChart",
                    "props": {"kind": "line", "x": "month", "y": "revenue"},
                    "data": {
                        "$ref": _WIDE_REF,
                        "bind": {"region": {"$state": "region", "values": _WIDE_VALUES}},
                    },
                },
            ],
            "events": [],
            "provenance": {"tier": "L0", "composedBy": "test", "cache": "miss"},
        }
    )


def test_resolves_every_initial_ref_but_caps_the_eagerly_preresolved_secondary_variants(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        invoked: list[str] = []

        class CountingDomain:
            async def list_operations(self) -> list[Any]:
                return []

            async def invoke(self, op: str, args: Any, ctx: Any) -> object:
                invoked.append(str(args.get("region")))
                return DATA

        deps = McpHostDeps(
            compose=make_compose_ctx(tmp_path, builder=_wide_bind_spec, ref=_WIDE_REF),
            domain=CountingDomain(),
            authz=SimpleAuthz(),
            query_source="sales",
        )
        async with connect(deps, _OPTIONS) as client:
            result = await client.call_tool("kohaku_compose", {"question": "Monthly revenue trend"})
        assert result.meta is not None
        initial = result.meta[INITIAL_DATA_META_KEY]
        # The initial variant (r0) is always embedded; of the 39 others, at most the first 32 are pre-resolved.
        assert "r0" in invoked
        assert len(invoked) == 1 + 32
        assert len(initial) == 1 + 32
        assert "r39" not in invoked

    asyncio.run(run())


_L1_REF = "query://sales/trend?granularity=month&metric=revenue&region=us"


class _FilterSemantic(_Semantic):
    async def describe_filters(
        self, intent: Intent, *, tenant: str | None = None, locale: str | None = None
    ) -> list[FilterDescriptor]:
        return [
            FilterDescriptor(
                param="region",
                queryParam="region",
                label="Region",
                options=[FilterOption(v, v) for v in ("us", "eu", "jp")],
            )
        ]


def _l1_filter_compose_ctx(tmp_path: Path) -> ComposeContext:
    from kohaku.storage import FileStoragePort

    draft = {
        "components": [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["c"]},
            {
                "id": "c",
                "type": "presentChart",
                "props": {"kind": "line", "x": "month", "y": "revenue"},
                "data": {"$ref": _L1_REF},
            },
        ],
        "events": [],
    }
    return ComposeContext(
        catalog=CATALOG,
        semantic=_FilterSemantic(ref=_L1_REF),
        storage=FileStoragePort(tmp_path),
        llm=FakeLlm(objects=[draft]),
        policy=ComposePolicy(l1Filters=True),
    )


def test_kohaku_compose_delivers_the_injected_spec_and_a_capability_resolving_every_variant(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        deps = McpHostDeps(
            compose=_l1_filter_compose_ctx(tmp_path),
            domain=TrendDomain(),
            authz=SimpleAuthz(),
            query_source="sales",
        )
        async with connect(deps, _OPTIONS) as client:
            composed = await client.call_tool(
                "kohaku_compose", {"question": "Monthly revenue trend"}
            )
            spec = composed.structured_content["spec"]
            assert spec["provenance"]["tier"] == "L1"
            assert spec["state"] == {"region": "us"}
            assert any(c["type"] == "control.select" for c in spec["components"])

            assert composed.meta is not None
            capability = composed.meta[CAPABILITY_META_KEY]
            for region in ("us", "eu", "jp"):
                resolved = await client.call_tool(
                    "kohaku_resolve_binding",
                    {
                        "ref": f"query://sales/trend?granularity=month&metric=revenue&region={region}",
                        "capability": capability,
                    },
                )
                assert not resolved.is_error

    asyncio.run(run())
