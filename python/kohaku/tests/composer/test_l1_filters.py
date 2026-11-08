"""Port of packages/composer/test/l1-filters.test.ts: ComposePolicy.l1Filters end to end (FakeLlm, no real LLM)."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import replace
from typing import Any

from kohaku.composer import (
    ComposeContext,
    ComposeOptions,
    ComposePolicy,
    FixedSpecSource,
    IntentComposeInput,
    compose,
    compose_stream,
)
from kohaku.composer.compose_stream import StreamDoneEvent, StreamPatchEvent
from kohaku.llm import FakeLlm
from kohaku.registry import core_catalog, resolve_catalog
from kohaku.spec import (
    FilterDescriptor,
    FilterOption,
    Intent,
    IntentInput,
    QueryHandle,
    SessionContext,
    UISpec,
    validate_spec_structure,
)
from kohaku.storage import FileStoragePort

_CATALOG = resolve_catalog(core_catalog())
_REF = "query://sales/summary?fy=2026&groupBy=region&q=3"

GROUP_BY = FilterDescriptor(
    param="groupBy",
    queryParam="groupBy",
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


def _ctx(
    tmp_path: Any,
    policy: ComposePolicy,
    semantic: Any = None,
    llm: FakeLlm | None = None,
) -> ComposeContext:
    return ComposeContext(
        catalog=_CATALOG,
        semantic=semantic if semantic is not None else _Semantic(_describe([GROUP_BY])),
        storage=FileStoragePort(tmp_path),
        llm=llm if llm is not None else FakeLlm(objects=[_draft()]),
        policy=policy,
    )


def _describe(descriptors: list[FilterDescriptor]) -> _DescribeFilters:
    async def describe(intent: Intent, *, tenant: str | None = None) -> list[FilterDescriptor]:
        return descriptors

    return describe


_INPUT = IntentComposeInput(
    intent=IntentInput(canonical="sales.summary", params={"groupBy": "region"})
)


def test_injects_the_intents_filters_into_a_generated_l1_spec_and_the_spec_validates(
    tmp_path: Any,
) -> None:
    async def run() -> None:
        result = await compose(_INPUT, _ctx(tmp_path, ComposePolicy(l1Filters=True)))
        spec = result.spec
        assert spec.provenance.tier == "L1"
        assert result.trace.filters is not None
        assert result.trace.filters.injected == ["groupBy"]
        assert result.trace.filters.skipped is None
        assert spec.state == {"groupBy": "region"}

        control = next(c for c in spec.components if c.type == "control.select")
        assert control.id == "filter-groupBy"
        # The injected control went through canonical_props like every other node (catalog version filled).
        assert control.version is not None
        assert spec.components[0].children is not None
        assert spec.components[0].children[0] == "filter-groupBy"

        bound = [c for c in spec.components if c.data is not None and c.data.bind is not None]
        assert len(bound) >= 2
        for c in bound:
            assert c.data is not None and c.data.bind is not None
            assert c.data.bind["groupBy"].to_wire() == {
                "$state": "groupBy",
                "values": ["region", "product", "channel"],
            }
        assert any(
            e.on == "filter-groupBy.change"
            and e.emit == "state.set"
            and e.payload == {"key": "groupBy", "value": "$value"}
            for e in spec.events
        )
        assert [i for i in validate_spec_structure(spec) if i.severity == "error"] == []

    asyncio.run(run())


def test_is_off_by_default_no_injection_no_trace_filters_and_describe_filters_never_called(
    tmp_path: Any,
) -> None:
    async def run() -> None:
        called = 0

        async def describe(intent: Intent, *, tenant: str | None = None) -> list[FilterDescriptor]:
            nonlocal called
            called += 1
            return [GROUP_BY]

        for policy in (ComposePolicy(), ComposePolicy(l1Filters=False)):
            result = await compose(
                _INPUT,
                _ctx(
                    tmp_path, policy, semantic=_Semantic(describe), llm=FakeLlm(objects=[_draft()])
                ),
            )
            assert result.spec.state is None
            assert not any(c.type == "control.select" for c in result.spec.components)
            assert result.trace.filters is None
        assert called == 0

    asyncio.run(run())


def test_separates_the_cache_key_from_the_same_policy_without_it(tmp_path: Any) -> None:
    async def run() -> None:
        off = await compose(_INPUT, _ctx(tmp_path / "a", ComposePolicy()))
        on = await compose(_INPUT, _ctx(tmp_path / "b", ComposePolicy(l1Filters=True)))
        assert on.trace.cacheKey != off.trace.cacheKey
        assert on.trace.cacheKeyParts.policyFingerprint not in (None, "")
        assert off.trace.cacheKeyParts.policyFingerprint in (None, "")

    asyncio.run(run())


def test_serves_the_injected_spec_from_the_cache_on_the_second_compose(tmp_path: Any) -> None:
    async def run() -> None:
        ctx = _ctx(tmp_path, ComposePolicy(l1Filters=True))
        first = await compose(_INPUT, ctx)
        second = await compose(_INPUT, replace(ctx, llm=FakeLlm(objects=[])))
        assert second.trace.cache == "hit"
        assert second.spec.state == first.spec.state
        assert [c.to_wire() for c in second.spec.components] == [
            c.to_wire() for c in first.spec.components
        ]

    asyncio.run(run())


def test_delivers_the_spec_as_generated_without_describe_filters_or_with_none_or_a_raise(
    tmp_path: Any,
) -> None:
    async def run() -> None:
        async def empty(intent: Intent, *, tenant: str | None = None) -> list[FilterDescriptor]:
            return []

        async def boom(intent: Intent, *, tenant: str | None = None) -> list[FilterDescriptor]:
            raise RuntimeError("boom")

        for i, semantic in enumerate((_Semantic(), _Semantic(empty), _Semantic(boom))):
            ctx = _ctx(tmp_path / str(i), ComposePolicy(l1Filters=True), semantic=semantic)
            result = await compose(_INPUT, ctx)
            assert result.spec.provenance.tier == "L1"
            assert result.spec.state is None
            assert not any(c.type == "control.select" for c in result.spec.components)
            assert result.trace.filters is None

    asyncio.run(run())


def test_falls_back_to_the_uninjected_spec_and_records_the_reason_when_the_variant_limit_is_exceeded(
    tmp_path: Any,
) -> None:
    async def run() -> None:
        many = FilterDescriptor(
            param="groupBy",
            queryParam="groupBy",
            label="Group by",
            options=[
                FilterOption("region", "region"),
                *(FilterOption(f"v{i}", f"v{i}") for i in range(200)),
            ],
        )
        result = await compose(
            _INPUT,
            _ctx(tmp_path, ComposePolicy(l1Filters=True), semantic=_Semantic(_describe([many]))),
        )
        assert result.trace.filters is not None
        assert result.trace.filters.injected == []
        assert result.trace.filters.skipped == "variant-limit"
        assert result.spec.state is None
        assert not any(c.type == "control.select" for c in result.spec.components)

    asyncio.run(run())


def test_passes_the_resolved_tenant_to_describe_filters_and_no_locale(tmp_path: Any) -> None:
    async def run() -> None:
        seen: list[dict[str, Any]] = []

        async def describe(intent: Intent, **kwargs: Any) -> list[FilterDescriptor]:
            seen.append(kwargs)
            return [GROUP_BY]

        await compose(
            _INPUT,
            _ctx(tmp_path, ComposePolicy(l1Filters=True), semantic=_Semantic(describe)),
            ComposeOptions(session=SessionContext(surface="web", tenant="acme", locale="ja")),
        )
        assert seen == [{"tenant": "acme"}]

    asyncio.run(run())


def test_does_not_inject_into_an_l0_fixed_spec(tmp_path: Any) -> None:
    async def run() -> None:
        class _Fixed(FixedSpecSource):
            async def lookup(self, intent: Intent) -> Any:
                def build(intent: Intent, handles: list[QueryHandle]) -> UISpec:
                    return UISpec.model_validate(
                        {
                            "kohaku": "0.2",
                            "intent": intent.to_wire(),
                            "dataVersion": "template",
                            "components": [
                                {
                                    "id": "root",
                                    "type": "layout.stack",
                                    "props": {},
                                    "children": ["c"],
                                },
                                {
                                    "id": "c",
                                    "type": "presentChart",
                                    "props": {"kind": "bar", "x": "region", "y": "revenue"},
                                    "data": {"$ref": handles[0].uri},
                                },
                            ],
                            "events": [],
                            "provenance": {
                                "tier": "L0",
                                "composedBy": "fixed-spec-template",
                                "cache": "miss",
                            },
                        }
                    )

                return build

        result = await compose(
            _INPUT, _ctx(tmp_path, ComposePolicy(l1Filters=True, fixedSpecs=_Fixed()))
        )
        assert result.spec.provenance.tier == "L0"
        assert not any(c.type == "control.select" for c in result.spec.components)
        assert result.trace.filters is None

    asyncio.run(run())


def test_compose_stream_converges_on_the_injected_spec_in_its_single_final_patch(
    tmp_path: Any,
) -> None:
    async def run() -> None:
        events = [
            ev async for ev in compose_stream(_INPUT, _ctx(tmp_path, ComposePolicy(l1Filters=True)))
        ]
        patches = [e for e in events if isinstance(e, StreamPatchEvent)]
        last = patches[-1]
        assert last.spec.state == {"groupBy": "region"}
        # Exactly the last patch is marked final (the host attaches the bind-variant capability to it).
        assert [p.final for p in patches].count(True) == 1
        assert last.final is True
        assert isinstance(events[-1], StreamDoneEvent)

    asyncio.run(run())
