"""ComposeTrace.cacheKeyParts and ComposeOptions.correlation_id (port of TS composer's
cache-key-parts.test.ts / correlation-id.test.ts — no real LLM is called)."""

from __future__ import annotations

import asyncio
from typing import Any

from kohaku.composer import (
    ComposeContext,
    ComposeOptions,
    ComposePolicy,
    IntentComposeInput,
    compose,
)
from kohaku.llm import FakeLlm, LlmPort
from kohaku.registry import core_catalog, resolve_catalog
from kohaku.spec import SPEC_VERSION, IntentInput, cache_key
from kohaku.storage import FileStoragePort

from .test_compose import _FakeSemantic, _l1_draft

_CATALOG = resolve_catalog(core_catalog())
_INTENT_INPUT = IntentComposeInput(intent=IntentInput(canonical="sales.summary", params={"fy": 2026}))


def _ctx(llm: LlmPort, storage: FileStoragePort, policy: ComposePolicy | None = None) -> ComposeContext:
    return ComposeContext(catalog=_CATALOG, semantic=_FakeSemantic(), storage=storage, llm=llm, policy=policy)


class TestCacheKeyParts:
    def test_carries_the_exact_components_cache_key_was_built_from(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            ctx = _ctx(FakeLlm(objects=[_l1_draft()]), storage)
            result = await compose(_INTENT_INPUT, ctx)
            parts = result.trace.cacheKeyParts
            assert parts.intentHash == result.trace.intent.hash
            assert parts.dataVersion == result.trace.dataVersion
            assert parts.catalogFingerprint == _CATALOG.fingerprint
            # Regression: specVersion was previously left unset on the recorded parts even though
            # cache_key() always falls back to SPEC_VERSION internally when building the key string --
            # so `kohaku explain`/DevTools showed a "-" placeholder for a component that had in fact
            # contributed a real segment.
            assert parts.specVersion == SPEC_VERSION
            # cache_key() applied to the recorded parts reproduces the recorded cacheKey exactly.
            assert cache_key(parts) == result.trace.cacheKey

        asyncio.run(run())

    def test_carries_every_component_cache_key_reads_and_rebuilding_reproduces_the_recorded_key(
        self, tmp_path: Any
    ) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            policy = ComposePolicy(generatorVersion="gen-2", outputLanguage="Japanese")
            ctx = _ctx(FakeLlm(objects=[_l1_draft()]), storage, policy=policy)
            result = await compose(_INTENT_INPUT, ctx)
            parts = result.trace.cacheKeyParts
            assert parts.intentHash
            assert parts.dataVersion
            assert parts.catalogFingerprint
            assert parts.specVersion
            assert parts.generatorVersion
            assert parts.policyFingerprint
            assert cache_key(parts) == result.trace.cacheKey

        asyncio.run(run())

    def test_unchanged_on_a_cache_hit(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            ctx = _ctx(FakeLlm(objects=[_l1_draft()]), storage)
            first = await compose(_INTENT_INPUT, ctx)
            second = await compose(_INTENT_INPUT, _ctx(FakeLlm(objects=[_l1_draft()]), storage))
            assert second.trace.cache == "hit"
            assert second.trace.cacheKeyParts == first.trace.cacheKeyParts
            assert cache_key(second.trace.cacheKeyParts) == second.trace.cacheKey

        asyncio.run(run())

    def test_includes_generator_version_and_policy_fingerprint_only_when_the_policy_sets_them(
        self, tmp_path: Any
    ) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            policy = ComposePolicy(generatorVersion="gen-2", outputLanguage="Japanese")
            ctx = _ctx(FakeLlm(objects=[_l1_draft()]), storage, policy=policy)
            result = await compose(_INTENT_INPUT, ctx)
            assert result.trace.cacheKeyParts.generatorVersion == "gen-2"
            assert result.trace.cacheKeyParts.policyFingerprint
            assert cache_key(result.trace.cacheKeyParts) == result.trace.cacheKey

        asyncio.run(run())


class TestComposeOptionsCorrelationId:
    def test_absent_from_the_trace_when_the_caller_passes_none(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            ctx = _ctx(FakeLlm(objects=[_l1_draft()]), storage)
            result = await compose(_INTENT_INPUT, ctx)
            assert result.trace.correlationId is None

        asyncio.run(run())

    def test_carried_through_to_the_delivered_trace_on_a_normal_compose(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            ctx = _ctx(FakeLlm(objects=[_l1_draft()]), storage)
            result = await compose(
                _INTENT_INPUT, ctx, ComposeOptions(correlation_id="req-abc")
            )
            assert result.trace.correlationId == "req-abc"

        asyncio.run(run())

    def test_carried_through_to_the_trace_on_a_cache_hit(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            ctx = _ctx(FakeLlm(objects=[_l1_draft()]), storage)
            await compose(_INTENT_INPUT, ctx, ComposeOptions(correlation_id="first"))
            second = await compose(
                _INTENT_INPUT,
                _ctx(FakeLlm(objects=[_l1_draft()]), storage),
                ComposeOptions(correlation_id="second-req"),
            )
            assert second.trace.cache == "hit"
            assert second.trace.correlationId == "second-req"

        asyncio.run(run())
