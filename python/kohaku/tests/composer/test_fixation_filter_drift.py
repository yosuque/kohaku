"""Port of packages/composer/test/fixation-filter-drift.test.ts.

A fixated injected L1 Spec (ComposePolicy.l1Filters) keeps its `data.bind` values -- the read scopes its
capability is built from. Delivery must therefore check them against the CURRENT filter descriptors (design.md
#78), by subset of values, so a removed option is stale instead of being re-signed.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import replace
from typing import Any

from kohaku.composer import (
    ComposeContext,
    ComposePolicy,
    IntentComposeInput,
    compose,
    materialize_fixation,
)
from kohaku.llm import FakeLlm
from kohaku.registry import core_catalog, resolve_catalog
from kohaku.spec import (
    FilterDescriptor,
    FilterOption,
    FixationRecord,
    Intent,
    IntentInput,
    Principal,
    QueryHandle,
    SessionContext,
    UISpec,
    compute_structure_hash,
)
from kohaku.storage import FileStoragePort

_CATALOG = resolve_catalog(core_catalog())
_REF = "query://sales/summary?fy=2026&groupBy=region&q=3"

GROUP_BY = FilterDescriptor(
    param="groupBy",
    queryParam="groupBy",
    paths=["summary"],
    label="Group by",
    options=[
        FilterOption("region", "By region"),
        FilterOption("product", "By product"),
        FilterOption("channel", "By channel"),
    ],
)

type _DescribeFilters = Callable[..., Awaitable[list[FilterDescriptor]]]


class _Semantic:
    """A deterministic SemanticPort; `describe_filters` is attached only when given (it is optional)."""

    def __init__(self, describe_filters: _DescribeFilters | None = None) -> None:
        if describe_filters is not None:
            self.describe_filters = describe_filters

    async def normalize(self, input: Any, ctx: SessionContext) -> IntentInput:
        return IntentInput(canonical="sales.summary", params={"groupBy": "region"})

    async def resolve_query(
        self, intent: Intent, *, tenant: str | None = None
    ) -> QueryHandle | list[QueryHandle]:
        return QueryHandle(uri=_REF)

    async def data_version(self, handle: QueryHandle) -> str:
        return "v1"

    async def describe_shape(self, handle: QueryHandle) -> None:
        return None


def _describing(descriptors: list[FilterDescriptor]) -> _DescribeFilters:
    async def describe(
        intent: Intent, *, tenant: str | None = None, locale: str | None = None
    ) -> list[FilterDescriptor]:
        return descriptors

    return describe


def _draft() -> dict[str, Any]:
    return {
        "components": [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["h", "c", "t"]},
            {"id": "h", "type": "text.heading", "props": {"level": 2, "text": "Sales"}},
            {
                "id": "c",
                "type": "presentChart",
                "props": {"kind": "bar", "x": "region", "y": "revenue"},
                "data": {"$ref": _REF},
            },
            {"id": "t", "type": "presentSpreadsheet", "props": {}, "data": {"$ref": _REF}},
        ],
        "events": [],
    }


def _ctx(tmp_path: Any, semantic: _Semantic) -> ComposeContext:
    return ComposeContext(
        catalog=_CATALOG,
        semantic=semantic,
        storage=FileStoragePort(tmp_path),
        llm=FakeLlm(objects=[_draft()]),
        policy=ComposePolicy(l1Filters=True),
    )


_INPUT = IntentComposeInput(
    intent=IntentInput(canonical="sales.summary", params={"groupBy": "region"})
)


async def _injected_fixation(tmp_path: Any) -> tuple[FixationRecord, Intent]:
    result = await compose(_INPUT, _ctx(tmp_path, _Semantic(_describing([GROUP_BY]))))
    spec = result.spec
    assert any(c.data is not None and c.data.bind for c in spec.components)
    fixation = FixationRecord(
        intentHash=spec.intent.hash,
        canonical=spec.intent.canonical,
        structureHash=compute_structure_hash(spec),
        pinnedSpec=spec,
        fixatedAt="2026-11-08T00:00:00Z",
        approver=Principal(id="tester"),
        catalogFingerprint=_CATALOG.fingerprint,
    )
    return fixation, spec.intent


def test_is_fresh_when_the_descriptors_are_unchanged(tmp_path: Any) -> None:
    async def run() -> None:
        fixation, intent = await _injected_fixation(tmp_path / "a")
        result, check = await materialize_fixation(
            fixation, intent, _ctx(tmp_path / "b", _Semantic(_describing([GROUP_BY])))
        )
        assert check.kind == "fresh"
        assert result is not None and result.spec.provenance.cache == "fixated"

    asyncio.run(run())


def test_is_stale_when_an_option_the_pinned_bind_carries_was_removed(tmp_path: Any) -> None:
    async def run() -> None:
        fixation, intent = await _injected_fixation(tmp_path / "a")
        narrowed = replace(GROUP_BY, options=GROUP_BY.options[:2])
        result, check = await materialize_fixation(
            fixation, intent, _ctx(tmp_path / "b", _Semantic(_describing([narrowed])))
        )
        assert result is None
        assert check.kind == "stale"
        assert check.issues is not None
        joined = " ".join(check.issues)
        assert "filter options drifted" in joined and "channel" in joined

    asyncio.run(run())


def test_is_stale_when_the_filter_was_removed_or_no_longer_governs_the_carrying_path(
    tmp_path: Any,
) -> None:
    async def run() -> None:
        fixation, intent = await _injected_fixation(tmp_path / "a")
        for i, now in enumerate([[], [replace(GROUP_BY, paths=["trend"])]]):
            result, check = await materialize_fixation(
                fixation, intent, _ctx(tmp_path / f"b{i}", _Semantic(_describing(now)))
            )
            assert result is None
            assert check.kind == "stale"

    asyncio.run(run())


def test_compares_by_subset_of_values_not_by_hash(tmp_path: Any) -> None:
    async def run() -> None:
        fixation, intent = await _injected_fixation(tmp_path / "a")
        relabelled = replace(
            GROUP_BY,
            label="集計軸",
            options=[FilterOption(o.value, f"{o.label} (renamed)") for o in GROUP_BY.options],
        )
        widened = replace(
            GROUP_BY, options=[*GROUP_BY.options, FilterOption("weekday", "By weekday")]
        )
        for i, now in enumerate([relabelled, widened]):
            result, check = await materialize_fixation(
                fixation, intent, _ctx(tmp_path / f"b{i}", _Semantic(_describing([now])))
            )
            assert check.kind == "fresh"
            assert result is not None

    asyncio.run(run())


def test_keeps_todays_behaviour_without_a_descriptor_source_or_when_it_raises(
    tmp_path: Any,
) -> None:
    async def run() -> None:
        fixation, intent = await _injected_fixation(tmp_path / "a")

        async def boom(
            intent: Intent, *, tenant: str | None = None, locale: str | None = None
        ) -> list[FilterDescriptor]:
            raise RuntimeError("boom")

        for i, semantic in enumerate([_Semantic(), _Semantic(boom)]):
            result, check = await materialize_fixation(
                fixation, intent, _ctx(tmp_path / f"b{i}", semantic)
            )
            assert check.kind == "fresh"
            assert result is not None

    asyncio.run(run())


def test_forwards_the_tenant_and_never_calls_describe_filters_for_a_spec_without_data_bind(
    tmp_path: Any,
) -> None:
    async def run() -> None:
        fixation, intent = await _injected_fixation(tmp_path / "a")
        seen: list[str | None] = []

        async def describe(
            intent: Intent, *, tenant: str | None = None, locale: str | None = None
        ) -> list[FilterDescriptor]:
            seen.append(tenant)
            return [GROUP_BY]

        await materialize_fixation(
            fixation, intent, _ctx(tmp_path / "b", _Semantic(describe)), "acme"
        )
        assert seen == ["acme"]

        wire = fixation.pinnedSpec.to_wire()
        for c in wire["components"]:
            if "data" in c:
                c["data"].pop("bind", None)
        plain = UISpec.model_validate(wire)
        plain_fixation = replace(
            fixation, pinnedSpec=plain, structureHash=compute_structure_hash(plain)
        )
        called = 0

        async def counting(
            intent: Intent, *, tenant: str | None = None, locale: str | None = None
        ) -> list[FilterDescriptor]:
            nonlocal called
            called += 1
            return []

        _, check = await materialize_fixation(
            plain_fixation, intent, _ctx(tmp_path / "c", _Semantic(counting))
        )
        assert check.kind == "fresh"
        assert called == 0

    asyncio.run(run())
