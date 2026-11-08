"""Port of packages/semantic-llm/test/port.test.ts (1:1)."""

from __future__ import annotations

import asyncio

import pytest

from kohaku.intents import (
    EnumField,
    FacetSpec,
    IntentDef,
    IntentSpec,
    QueryTemplate,
    define_intent,
    object_schema,
)
from kohaku.llm import FakeLlm
from kohaku.semantic_llm import (
    IntentCatalogLike,
    NormalizedInfo,
    UnknownIntentError,
    create_intent_catalog,
    create_llm_semantic_port,
)
from kohaku.spec import (
    DataShape,
    FilterDescriptor,
    FilterOption,
    GuiAction,
    Intent,
    IntentInput,
    IntentValidationError,
    JsonObject,
    NLQuery,
    QueryHandle,
    QueryRef,
    SessionContext,
    finalize_intent,
)

catalog = create_intent_catalog(
    [
        define_intent(
            IntentSpec(
                canonical="sales.summary",
                description="Summary",
                source="sales",
                params=object_schema(
                    {"groupBy": EnumField(values=("region", "product")).default("region")}
                ),
                examples=[],
                queries=[QueryTemplate(path="summary", paramMap={"groupBy": "groupBy"})],
            )
        ).to_intent_def()
    ]
)


def _catalog_for(tenant: str | None) -> IntentCatalogLike:
    if tenant == "t2":
        return create_intent_catalog([])
    return catalog


def _describe_shape(ref: QueryRef) -> DataShape | None:
    if ref.path != "summary":
        return None
    return DataShape.model_validate(
        {
            "columns": [
                {
                    "name": str(ref.params.get("groupBy", "region")),
                    "type": "string",
                    "role": "dimension",
                }
            ]
        }
    )


port = create_llm_semantic_port(
    llm=FakeLlm(),
    catalog=_catalog_for,
    data_version=lambda _h: "sales@v1",
    describe_shape=_describe_shape,
)

WEB = SessionContext(surface="web")


class TestCreateLlmSemanticPort:
    def test_resolve_query_expands_the_intents_query_templates_per_tenant_catalog(self) -> None:
        intent = finalize_intent(
            IntentInput(canonical="sales.summary", params={"groupBy": "product"})
        )
        assert asyncio.run(port.resolve_query(intent)) == [
            QueryHandle(uri="query://sales/summary?groupBy=product")
        ]
        with pytest.raises(UnknownIntentError, match="unknown intent"):
            asyncio.run(
                port.resolve_query(
                    finalize_intent(IntentInput(canonical="sales.summary", params={})), tenant="t2"
                )
            )

    def test_resolve_query_on_an_unknown_intent_throws_a_typed_client_safe_error(self) -> None:
        intent = finalize_intent(IntentInput(canonical="sales.summary", params={}))
        with pytest.raises(UnknownIntentError) as info:
            asyncio.run(port.resolve_query(intent, tenant="t2"))
        error = info.value
        assert error.code == "UNKNOWN_INTENT"
        # clientSafe is what actually lets composer's SEMANTIC_FAILED wrapping surface this message to the
        # client -- `code` alone is not enough.
        assert error.clientSafe is True
        assert error.canonical == "sales.summary"
        assert str(error) == 'unknown intent "sales.summary"'

    def test_data_version_delegates_to_the_option(self) -> None:
        assert (
            asyncio.run(port.data_version(QueryHandle(uri="query://sales/summary"))) == "sales@v1"
        )

    def test_data_version_awaits_an_async_option(self) -> None:
        async def version(_handle: QueryHandle) -> str:
            return "async@v2"

        p = create_llm_semantic_port(llm=FakeLlm(), catalog=catalog, data_version=version)
        assert asyncio.run(p.data_version(QueryHandle(uri="query://sales/summary"))) == "async@v2"

    def test_describe_shape_parses_the_ref_and_delegates_an_unknown_path_throws(self) -> None:
        shape = asyncio.run(
            port.describe_shape(QueryHandle(uri="query://sales/summary?groupBy=product"))
        )
        assert shape is not None
        assert [(c.name, c.type, c.role) for c in shape.columns] == [
            ("product", "string", "dimension")
        ]
        with pytest.raises(ValueError, match="unknown query path"):
            asyncio.run(port.describe_shape(QueryHandle(uri="query://sales/nope")))

    def test_describe_shape_answers_none_when_the_option_is_omitted(self) -> None:
        p = create_llm_semantic_port(llm=FakeLlm(), catalog=catalog, data_version=lambda _h: "v")
        assert asyncio.run(p.describe_shape(QueryHandle(uri="query://sales/summary"))) is None

    def test_gui_input_never_touches_the_llm(self) -> None:
        llm = FakeLlm()
        p = create_llm_semantic_port(llm=llm, catalog=catalog, data_version=lambda _h: "v")
        out = asyncio.run(
            p.normalize(
                GuiAction(kind="gui", action="view.select", params={"intent": "sales.summary"}),
                WEB,
            )
        )
        assert out == IntentInput(canonical="sales.summary", params={"groupBy": "region"})
        assert len(llm.calls) == 0

    def test_threads_the_rules_callback_and_the_session_context_through_to_the_system_prompt(
        self,
    ) -> None:
        llm = FakeLlm(objects=[{"intent": "sales.summary", "params": {"groupBy": "product"}}])
        p = create_llm_semantic_port(
            llm=llm,
            catalog=catalog,
            data_version=lambda _h: "v",
            rules=lambda ctx: [f"- the requesting tenant is {ctx.tenant or 'none'}"],
        )
        asyncio.run(
            p.normalize(
                NLQuery(kind="nl", text="top products"),
                SessionContext(surface="chat", tenant="acme"),
            )
        )
        assert len(llm.calls) == 1
        assert llm.calls[0].system is not None
        assert "- the requesting tenant is acme" in llm.calls[0].system

    def test_on_normalized_fires_after_a_matched_nl_normalization_with_the_sessions_tenant(
        self,
    ) -> None:
        llm = FakeLlm(objects=[{"intent": "sales.summary", "params": {"groupBy": "product"}}])
        seen: list[NormalizedInfo] = []
        p = create_llm_semantic_port(
            llm=llm,
            catalog=catalog,
            data_version=lambda _h: "v",
            on_normalized=seen.append,
        )
        asyncio.run(
            p.normalize(
                NLQuery(kind="nl", text="top products"),
                SessionContext(surface="chat", tenant="acme"),
            )
        )
        assert seen == [
            NormalizedInfo(
                text="top products", canonical="sales.summary", fallback=False, tenant="acme"
            )
        ]

    def test_on_normalized_fires_with_fallback_true_and_no_tenant_when_the_session_has_none(
        self,
    ) -> None:
        llm = FakeLlm(
            objects=[{"intent": "sales.summary", "params": {"groupBy": "not-a-valid-value"}}]
        )
        seen: list[NormalizedInfo] = []
        p = create_llm_semantic_port(
            llm=llm,
            catalog=catalog,
            data_version=lambda _h: "v",
            fallback_intent="sales.summary",
            on_normalized=seen.append,
        )
        asyncio.run(
            p.normalize(NLQuery(kind="nl", text="top products"), SessionContext(surface="chat"))
        )
        assert seen == [
            NormalizedInfo(text="top products", canonical="sales.summary", fallback=True)
        ]

    def test_on_normalized_is_never_called_before_a_throw(self) -> None:
        llm = FakeLlm(
            objects=[{"intent": "sales.summary", "params": {"groupBy": "not-a-valid-value"}}]
        )
        calls = 0

        def hook(_info: NormalizedInfo) -> None:
            nonlocal calls
            calls += 1
            raise RuntimeError("boom")

        # no fallback_intent: the mismatch raises SemanticNormalizeError, so the hook must never run.
        p = create_llm_semantic_port(
            llm=llm, catalog=catalog, data_version=lambda _h: "v", on_normalized=hook
        )
        with pytest.raises(Exception):  # noqa: B017
            asyncio.run(
                p.normalize(NLQuery(kind="nl", text="top products"), SessionContext(surface="chat"))
            )
        assert calls == 0

    def test_a_throwing_on_normalized_hook_is_caught_and_ignored_fail_open(self) -> None:
        llm = FakeLlm(
            objects=[{"intent": "sales.summary", "params": {"groupBy": "not-a-valid-value"}}]
        )
        calls = 0

        def hook(_info: NormalizedInfo) -> None:
            nonlocal calls
            calls += 1
            raise RuntimeError("boom")

        p = create_llm_semantic_port(
            llm=llm,
            catalog=catalog,
            data_version=lambda _h: "v",
            fallback_intent="sales.summary",
            on_normalized=hook,
        )
        out = asyncio.run(
            p.normalize(NLQuery(kind="nl", text="top products"), SessionContext(surface="chat"))
        )
        assert out == IntentInput(canonical="sales.summary", params={"groupBy": "region"})
        assert calls == 1

    def test_output_locale_maps_the_locale_tag_into_the_prompt_label(self) -> None:
        llm = FakeLlm(objects=[{"intent": "sales.summary", "params": {}}])
        p = create_llm_semantic_port(
            llm=llm,
            catalog=catalog,
            data_version=lambda _h: "v",
            output_locale=lambda tag: "ja" if (tag or "").startswith("ja") else "en",
        )
        asyncio.run(
            p.normalize(
                NLQuery(kind="nl", text="売上", locale="ja-JP"), SessionContext(surface="chat")
            )
        )
        assert "## User question (ja)" in llm.calls[0].prompt


class TestValidateIntent:
    def test_accepts_a_fully_specified_intent_and_returns_it_unchanged(self) -> None:
        result = asyncio.run(
            port.validate_intent(
                IntentInput(canonical="sales.summary", params={"groupBy": "product"}), WEB
            )
        )
        assert result == IntentInput(canonical="sales.summary", params={"groupBy": "product"})

    def test_fills_in_a_schema_default_the_caller_omitted(self) -> None:
        result = asyncio.run(
            port.validate_intent(IntentInput(canonical="sales.summary", params={}), WEB)
        )
        assert result == IntentInput(canonical="sales.summary", params={"groupBy": "region"})

    def test_rejects_an_unknown_canonical(self) -> None:
        with pytest.raises(IntentValidationError, match=r'unknown intent "sales\.bogus"'):
            asyncio.run(port.validate_intent(IntentInput(canonical="sales.bogus", params={}), WEB))

    def test_rejects_an_invalid_param_value(self) -> None:
        with pytest.raises(IntentValidationError):
            asyncio.run(
                port.validate_intent(
                    IntentInput(canonical="sales.summary", params={"groupBy": "not-a-valid-value"}),
                    WEB,
                )
            )

    def test_rejects_an_unknown_param_key_via_the_catalogs_validate_params(self) -> None:
        with pytest.raises(IntentValidationError) as info:
            asyncio.run(
                port.validate_intent(
                    IntentInput(
                        canonical="sales.summary", params={"groupBy": "region", "bogus": 1}
                    ),
                    WEB,
                )
            )
        assert [(i.path, i.message) for i in info.value.issues] == [
            ("bogus", 'unknown param "bogus"')
        ]

    def test_resolves_the_per_tenant_catalog(self) -> None:
        with pytest.raises(IntentValidationError, match="unknown intent"):
            asyncio.run(
                port.validate_intent(
                    IntentInput(canonical="sales.summary", params={}),
                    SessionContext(surface="web", tenant="t2"),
                )
            )

    def test_falls_back_to_the_looser_checks_when_the_catalog_has_no_validate_params(self) -> None:
        class LooseCatalog:
            """A minimal IntentCatalogLike that implements only the required members."""

            def get(self, name: str) -> IntentDef | None:
                return catalog.get(name)

            def list_defs(self) -> list[IntentDef]:
                return catalog.list_defs()

            def names(self) -> list[str]:
                return catalog.names()

            def normalize_params(self, name: str, params: JsonObject) -> JsonObject | None:
                return catalog.normalize_params(name, params)

        p = create_llm_semantic_port(
            llm=FakeLlm(), catalog=LooseCatalog(), data_version=lambda _h: "v"
        )
        # Fully valid params still succeed.
        assert asyncio.run(
            p.validate_intent(
                IntentInput(canonical="sales.summary", params={"groupBy": "product"}), WEB
            )
        ) == IntentInput(canonical="sales.summary", params={"groupBy": "product"})
        # An unknown canonical is still rejected.
        with pytest.raises(IntentValidationError):
            asyncio.run(p.validate_intent(IntentInput(canonical="sales.bogus", params={}), WEB))
        # But an unknown param key is silently stripped rather than rejected (the fallback's known
        # limitation -- normalize_params' plain safe_parse cannot distinguish it from a valid request).
        assert asyncio.run(
            p.validate_intent(
                IntentInput(canonical="sales.summary", params={"groupBy": "region", "bogus": 1}),
                WEB,
            )
        ) == IntentInput(canonical="sales.summary", params={"groupBy": "region"})


class TestDescribeFilters:
    """Port of port.test.ts's `createLlmSemanticPort describeFilters` describe block."""

    filtered = create_intent_catalog(
        [
            define_intent(
                IntentSpec(
                    canonical="sales.filtered",
                    description="Filtered",
                    source="sales",
                    params=object_schema(
                        {"groupBy": EnumField(values=("region", "product")).default("region")}
                    ),
                    examples=[],
                    facets=[FacetSpec(param="groupBy", label="Group by", labels={"ja": "集計軸"})],
                    queries=[QueryTemplate(path="summary", paramMap={"groupBy": "by"})],
                )
            ).to_intent_def(),
            # No facets declared: the Intent exposes no filters.
            define_intent(
                IntentSpec(
                    canonical="sales.plain",
                    description="Plain",
                    source="sales",
                    params=object_schema(
                        {"groupBy": EnumField(values=("region", "product")).default("region")}
                    ),
                    examples=[],
                    queries=[QueryTemplate(path="summary", paramMap={"groupBy": "by"})],
                )
            ).to_intent_def(),
        ]
    )
    port = create_llm_semantic_port(
        llm=FakeLlm(),
        catalog=lambda tenant: (
            create_intent_catalog([]) if tenant == "t2" else TestDescribeFilters.filtered
        ),
        data_version=lambda _h: "v",
    )

    @staticmethod
    def _intent(canonical: str) -> Intent:
        return Intent(canonical=canonical, params={"groupBy": "region"}, hash=f"sha256:{'ab' * 32}")

    def test_delegates_to_the_intent_definitions_filters(self) -> None:
        out = asyncio.run(self.port.describe_filters(self._intent("sales.filtered")))
        assert out == [
            FilterDescriptor(
                param="groupBy",
                queryParam="by",
                label="Group by",
                options=[FilterOption("region", "region"), FilterOption("product", "product")],
            )
        ]

    def test_forwards_the_locale_and_selects_the_per_tenant_catalog(self) -> None:
        localized = asyncio.run(
            self.port.describe_filters(self._intent("sales.filtered"), locale="ja")
        )
        assert localized[0].label == "集計軸"
        assert (
            asyncio.run(self.port.describe_filters(self._intent("sales.filtered"), tenant="t2"))
            == []
        )

    def test_returns_empty_for_an_intent_without_facets_or_an_unknown_intent(self) -> None:
        assert asyncio.run(self.port.describe_filters(self._intent("sales.plain"))) == []
        assert asyncio.run(self.port.describe_filters(self._intent("sales.bogus"))) == []
