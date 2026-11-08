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
    DataShape,
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
    async def describe(
        intent: Intent, *, tenant: str | None = None, locale: str | None = None
    ) -> list[FilterDescriptor]:
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

        async def describe(
            intent: Intent, *, tenant: str | None = None, locale: str | None = None
        ) -> list[FilterDescriptor]:
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
        async def empty(
            intent: Intent, *, tenant: str | None = None, locale: str | None = None
        ) -> list[FilterDescriptor]:
            return []

        async def boom(
            intent: Intent, *, tenant: str | None = None, locale: str | None = None
        ) -> list[FilterDescriptor]:
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
            paths=["summary"],
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


def test_passes_the_resolved_tenant_and_session_locale_to_describe_filters(tmp_path: Any) -> None:
    async def run() -> None:
        seen: list[dict[str, Any]] = []

        async def describe(intent: Intent, **kwargs: Any) -> list[FilterDescriptor]:
            seen.append(kwargs)
            return [GROUP_BY]

        await compose(
            _INPUT,
            _ctx(tmp_path / "a", ComposePolicy(l1Filters=True), semantic=_Semantic(describe)),
            ComposeOptions(session=SessionContext(surface="web", tenant="acme", locale="ja")),
        )
        await compose(
            _INPUT,
            _ctx(tmp_path / "b", ComposePolicy(l1Filters=True), semantic=_Semantic(describe)),
        )
        assert seen == [{"tenant": "acme", "locale": "ja"}, {"tenant": None, "locale": None}]

    asyncio.run(run())


_WIDENED = replace(GROUP_BY, options=[*GROUP_BY.options, FilterOption("weekday", "By weekday")])


def test_changing_options_labels_or_paths_yields_a_different_cache_key(tmp_path: Any) -> None:
    async def run() -> None:
        keys: set[str] = set()
        for i, d in enumerate(
            (
                GROUP_BY,
                _WIDENED,
                replace(GROUP_BY, label="Group by (renamed)"),
                replace(GROUP_BY, paths=["summary", "trend"]),
            )
        ):
            result = await compose(
                _INPUT,
                _ctx(
                    tmp_path / str(i),
                    ComposePolicy(l1Filters=True),
                    semantic=_Semantic(_describe([d])),
                ),
            )
            keys.add(result.trace.cacheKey)
        assert len(keys) == 4
        off = await compose(
            _INPUT,
            _ctx(tmp_path / "off", ComposePolicy(), semantic=_Semantic(_describe([GROUP_BY]))),
        )
        assert off.trace.cacheKey not in keys
        same_a = await compose(_INPUT, _ctx(tmp_path / "sa", ComposePolicy(l1Filters=True)))
        same_b = await compose(
            _INPUT,
            _ctx(
                tmp_path / "sb",
                ComposePolicy(l1Filters=True),
                semantic=_Semantic(_describe([replace(GROUP_BY)])),
            ),
        )
        assert same_a.trace.cacheKey == same_b.trace.cacheKey

    asyncio.run(run())


def _bind_values(spec: UISpec) -> list[str] | None:
    for c in spec.components:
        if c.data is not None and c.data.bind is not None:
            return list(c.data.bind["groupBy"].values)
    return None


def test_tenant_specific_descriptors_do_not_share_a_cached_spec(tmp_path: Any) -> None:
    async def run() -> None:
        async def describe(
            intent: Intent, *, tenant: str | None = None, locale: str | None = None
        ) -> list[FilterDescriptor]:
            return [GROUP_BY if tenant == "narrow" else _WIDENED]

        base = _ctx(tmp_path, ComposePolicy(l1Filters=True), semantic=_Semantic(describe))
        wide = await compose(
            _INPUT,
            base,
            ComposeOptions(session=SessionContext(surface="web", tenant="wide")),
        )
        narrow = await compose(
            _INPUT,
            replace(base, llm=FakeLlm(objects=[_draft()])),
            ComposeOptions(session=SessionContext(surface="web", tenant="narrow")),
        )
        # The narrow tenant is a miss that regenerates; it never receives the wide tenant's authorized range.
        assert narrow.trace.cache == "miss"
        assert narrow.trace.cacheKey != wide.trace.cacheKey
        assert "weekday" in (_bind_values(wide.spec) or [])
        assert "weekday" not in (_bind_values(narrow.spec) or [])
        again = await compose(
            _INPUT,
            replace(base, llm=FakeLlm(objects=[])),
            ComposeOptions(session=SessionContext(surface="web", tenant="narrow")),
        )
        assert again.trace.cache == "hit"
        assert _bind_values(again.spec) == _bind_values(narrow.spec)

    asyncio.run(run())


def test_session_locales_are_cached_separately_and_carry_their_own_labels(tmp_path: Any) -> None:
    async def run() -> None:
        async def describe(
            intent: Intent, *, tenant: str | None = None, locale: str | None = None
        ) -> list[FilterDescriptor]:
            return [replace(GROUP_BY, label="集計軸") if locale == "ja" else GROUP_BY]

        base = _ctx(tmp_path, ComposePolicy(l1Filters=True), semantic=_Semantic(describe))
        en = await compose(
            _INPUT, base, ComposeOptions(session=SessionContext(surface="web", locale="en"))
        )
        ja = await compose(
            _INPUT,
            replace(base, llm=FakeLlm(objects=[_draft()])),
            ComposeOptions(session=SessionContext(surface="web", locale="ja")),
        )
        assert ja.trace.cache == "miss"
        assert ja.trace.cacheKey != en.trace.cacheKey

        def label(spec: UISpec) -> object:
            return next(c for c in spec.components if c.type == "control.select").props["label"]

        assert label(en.spec) == "Group by"
        assert label(ja.spec) == "集計軸"

    asyncio.run(run())


def test_l1_filters_max_variants_caps_the_injection_and_joins_the_cache_key_only_when_not_64(
    tmp_path: Any,
) -> None:
    async def run() -> None:
        # 3 options x 2 data components = 6 variants.
        tight = await compose(
            _INPUT, _ctx(tmp_path / "t", ComposePolicy(l1Filters=True, l1FiltersMaxVariants=5))
        )
        assert tight.trace.filters is not None
        assert tight.trace.filters.injected == []
        assert tight.trace.filters.skipped == "variant-limit"
        assert tight.spec.state is None
        roomy = await compose(
            _INPUT, _ctx(tmp_path / "r", ComposePolicy(l1Filters=True, l1FiltersMaxVariants=6))
        )
        assert roomy.trace.filters is not None and roomy.trace.filters.injected == ["groupBy"]
        dflt = await compose(_INPUT, _ctx(tmp_path / "d", ComposePolicy(l1Filters=True)))
        explicit = await compose(
            _INPUT, _ctx(tmp_path / "e", ComposePolicy(l1Filters=True, l1FiltersMaxVariants=64))
        )
        assert explicit.trace.cacheKey == dflt.trace.cacheKey
        assert roomy.trace.cacheKey != dflt.trace.cacheKey
        assert tight.trace.cacheKey != roomy.trace.cacheKey

    asyncio.run(run())


# ---- shape guard: a filter whose options rename the result's columns is dropped (design.md #78) ----

_REGION_SHAPE = DataShape.model_validate(
    {
        "columns": [
            {"name": "region", "type": "string", "role": "dimension"},
            {"name": "revenue", "type": "number", "role": "measure"},
        ]
    }
)
_PRODUCT_SHAPE = DataShape.model_validate(
    {
        "columns": [
            {"name": "product", "type": "string", "role": "dimension"},
            {"name": "revenue", "type": "number", "role": "measure"},
        ]
    }
)

type _DescribeShape = Callable[[QueryHandle], Awaitable[DataShape | None]]


class _ShapedSemantic(_Semantic):
    """A `_Semantic` whose `describe_shape` is the given callable."""

    def __init__(self, shape: _DescribeShape | None) -> None:
        super().__init__(_describe([GROUP_BY]))
        self._shape = shape

    async def describe_shape(self, handle: QueryHandle) -> DataShape | None:  # type: ignore[override]
        if self._shape is None:
            return None
        return await self._shape(handle)


def _shape_by_group_by(seen: list[str] | None = None) -> _DescribeShape:
    async def shape(handle: QueryHandle) -> DataShape | None:
        if seen is not None:
            seen.append(handle.uri)
        return _REGION_SHAPE if "groupBy=region" in handle.uri else _PRODUCT_SHAPE

    return shape


def _constant_shape(value: DataShape) -> _DescribeShape:
    async def shape(handle: QueryHandle) -> DataShape | None:
        return value

    return shape


def test_shape_guard_drops_a_descriptor_whose_variants_change_the_column_set(
    tmp_path: Any,
) -> None:
    async def run() -> None:
        seen: list[str] = []
        result = await compose(
            _INPUT,
            _ctx(
                tmp_path,
                ComposePolicy(l1Filters=True),
                semantic=_ShapedSemantic(_shape_by_group_by(seen)),
            ),
        )
        assert result.spec.provenance.tier == "L1"
        assert result.trace.filters is None
        assert result.spec.state is None
        assert not any(c.type == "control.select" for c in result.spec.components)
        assert not any(
            c.data is not None and c.data.bind is not None for c in result.spec.components
        )
        # The first renaming variant (product) settled it; the current one (region) was described once, as the
        # handle's own baseline shape, never as a variant.
        assert len([u for u in seen if "groupBy=product" in u]) == 1

    asyncio.run(run())


def test_shape_guard_keeps_a_descriptor_whose_variants_keep_the_column_set(tmp_path: Any) -> None:
    async def run() -> None:
        result = await compose(
            _INPUT,
            _ctx(
                tmp_path,
                ComposePolicy(l1Filters=True),
                semantic=_ShapedSemantic(_constant_shape(_REGION_SHAPE)),
            ),
        )
        assert result.trace.filters is not None
        assert result.trace.filters.injected == ["groupBy"]

    asyncio.run(run())


def test_shape_guard_treats_column_order_as_no_change(tmp_path: Any) -> None:
    async def run() -> None:
        reordered = DataShape.model_validate(
            {"columns": [c.model_dump() for c in reversed(_REGION_SHAPE.columns)]}
        )

        async def shape(handle: QueryHandle) -> DataShape | None:
            return _REGION_SHAPE if "groupBy=region" in handle.uri else reordered

        result = await compose(
            _INPUT,
            _ctx(tmp_path, ComposePolicy(l1Filters=True), semantic=_ShapedSemantic(shape)),
        )
        assert result.trace.filters is not None
        assert result.trace.filters.injected == ["groupBy"]

    asyncio.run(run())


def test_shape_guard_drops_a_descriptor_when_a_variants_shape_cannot_be_described(
    tmp_path: Any,
) -> None:
    async def run() -> None:
        async def shape(handle: QueryHandle) -> DataShape | None:
            if "groupBy=channel" in handle.uri:
                raise ValueError("unknown query path")
            return _REGION_SHAPE

        result = await compose(
            _INPUT,
            _ctx(tmp_path, ComposePolicy(l1Filters=True), semantic=_ShapedSemantic(shape)),
        )
        assert result.trace.filters is None

    asyncio.run(run())


def test_shape_guard_leaves_the_descriptor_alone_when_there_is_nothing_to_compare_against(
    tmp_path: Any,
) -> None:
    async def run() -> None:
        # No shapes at all (the port answers None): today's behaviour.
        without = await compose(
            _INPUT,
            _ctx(tmp_path / "a", ComposePolicy(l1Filters=True), semantic=_ShapedSemantic(None)),
        )
        assert without.trace.filters is not None
        assert without.trace.filters.injected == ["groupBy"]

        # The initial handle's own shape fails: the guard has no baseline.
        async def shape(handle: QueryHandle) -> DataShape | None:
            if "groupBy=region" in handle.uri:
                raise ValueError("no shape")
            return _PRODUCT_SHAPE

        no_base = await compose(
            _INPUT,
            _ctx(tmp_path / "b", ComposePolicy(l1Filters=True), semantic=_ShapedSemantic(shape)),
        )
        assert no_base.trace.filters is not None
        assert no_base.trace.filters.injected == ["groupBy"]

    asyncio.run(run())


def test_shape_guard_a_dropped_descriptor_changes_the_cache_key(tmp_path: Any) -> None:
    async def run() -> None:
        kept = await compose(
            _INPUT,
            _ctx(
                tmp_path / "a",
                ComposePolicy(l1Filters=True),
                semantic=_ShapedSemantic(_constant_shape(_REGION_SHAPE)),
            ),
        )
        dropped = await compose(
            _INPUT,
            _ctx(
                tmp_path / "b",
                ComposePolicy(l1Filters=True),
                semantic=_ShapedSemantic(_shape_by_group_by()),
            ),
        )
        assert dropped.trace.cacheKey != kept.trace.cacheKey

    asyncio.run(run())


def test_records_skipped_invalid_at_compose_level_when_the_generated_root_cannot_host_controls(
    tmp_path: Any,
) -> None:
    async def run() -> None:
        # A single-component screen: the root is the chart itself (no children), so there is nowhere to put a control.
        leaf_root = {
            "components": [
                {
                    "id": "root",
                    "type": "presentChart",
                    "props": {"kind": "bar", "x": "region", "y": "revenue"},
                    "data": {"$ref": _REF},
                }
            ],
            "events": [],
        }
        result = await compose(
            _INPUT,
            _ctx(tmp_path, ComposePolicy(l1Filters=True), llm=FakeLlm(objects=[leaf_root])),
        )
        assert result.spec.provenance.fallback is None
        assert result.spec.provenance.tier == "L1"
        assert result.spec.state is None
        assert result.trace.filters is not None
        assert result.trace.filters.injected == []
        assert result.trace.filters.skipped == "invalid"

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
        # Exactly the last patch is marked converged (the host attaches the bind-variant capability to it).
        assert [p.converged for p in patches].count(True) == 1
        assert last.converged is True
        assert isinstance(events[-1], StreamDoneEvent)

    asyncio.run(run())
