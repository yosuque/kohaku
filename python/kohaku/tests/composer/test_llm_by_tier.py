"""Tests for ComposeContext.llmByTier (per-tier LLM routing).

A pytest port of packages/composer/test/llm-by-tier.test.ts's scenarios.
"""

from __future__ import annotations

import asyncio
from typing import Any

from kohaku.composer import (
    ComposePolicy,
    TierLlm,
    compose,
    policy_fingerprint,
    tier_llm_fingerprint_material,
)
from kohaku.llm import FakeLlm
from kohaku.storage import FileStoragePort

from .test_compose import _INTENT_INPUT, _L2_HTML, _ctx, _l1_draft


class TestLlmByTier:
    def test_l1_routed_to_llm_by_tier_l1(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            base_llm = FakeLlm(objects=[_l1_draft()], model_id="base-model")
            l1_llm = FakeLlm(objects=[_l1_draft()], model_id="l1-model")
            ctx = _ctx(base_llm, storage, ComposePolicy(), llmByTier=TierLlm(L1=l1_llm))

            result = await compose(_INTENT_INPUT, ctx)

            assert len(l1_llm.calls) == 1
            assert len(base_llm.calls) == 0
            assert result.trace.attempts[0].ok is True

        asyncio.run(run())

    def test_l2_routed_to_llm_by_tier_l2(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            base_llm = FakeLlm(objects=[_l1_draft()], model_id="base-model")
            l2_llm = FakeLlm(texts=[_L2_HTML], model_id="l2-model")
            ctx = _ctx(
                base_llm,
                storage,
                ComposePolicy(allowL2=True, routeTier=lambda _i: "L2"),
                llmByTier=TierLlm(L2=l2_llm),
            )

            await compose(_INTENT_INPUT, ctx)

            assert len(l2_llm.calls) == 1
            assert len(base_llm.calls) == 0

        asyncio.run(run())

    def test_tier_not_in_llm_by_tier_falls_back_to_base(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            base_llm = FakeLlm(objects=[_l1_draft()], model_id="base-model")
            l2_llm = FakeLlm(texts=[_L2_HTML], model_id="l2-model")
            # llmByTier only overrides L2; L1 (the route actually taken here) must still use base_llm.
            ctx = _ctx(base_llm, storage, ComposePolicy(), llmByTier=TierLlm(L2=l2_llm))

            await compose(_INTENT_INPUT, ctx)

            assert len(base_llm.calls) == 1
            assert len(l2_llm.calls) == 0

        asyncio.run(run())

    def test_l1_trace_model_is_the_tier_ports_model_id(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            base_llm = FakeLlm(objects=[_l1_draft()], model_id="base-model")
            l1_llm = FakeLlm(objects=[_l1_draft()], model_id="l1-fine-tuned")
            ctx = _ctx(base_llm, storage, ComposePolicy(), llmByTier=TierLlm(L1=l1_llm))

            result = await compose(_INTENT_INPUT, ctx)
            assert result.trace.tier == "L1"
            assert result.trace.model == "l1-fine-tuned"

        asyncio.run(run())

    def test_l2_trace_model_is_the_tier_ports_model_id_the_bug_this_fixes(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            base_llm = FakeLlm(objects=[_l1_draft()], model_id="base-model")
            l2_llm = FakeLlm(texts=[_L2_HTML], model_id="l2-fine-tuned")
            ctx = _ctx(
                base_llm,
                storage,
                ComposePolicy(allowL2=True, routeTier=lambda _i: "L2"),
                llmByTier=TierLlm(L2=l2_llm),
            )

            result = await compose(_INTENT_INPUT, ctx)
            assert result.trace.tier == "L2"
            assert result.trace.model == "l2-fine-tuned"

        asyncio.run(run())

    class TestCacheKeyCorrectness:
        def test_llm_by_tier_unset_cache_key_byte_identical(self, tmp_path: Any) -> None:
            async def run() -> None:
                storage = FileStoragePort(tmp_path)
                llm = FakeLlm(objects=[_l1_draft()], model_id="base-model")
                ctx = _ctx(llm, storage, ComposePolicy(generatorVersion="gv1"))
                assert tier_llm_fingerprint_material(ctx) is None
                result = await compose(_INTENT_INPUT, ctx)
                assert result.trace.cacheKey.endswith(":gv1")

            asyncio.run(run())

        def test_llm_by_tier_matching_base_no_fingerprint_contribution(self, tmp_path: Any) -> None:
            async def run() -> None:
                base_llm = FakeLlm(objects=[_l1_draft()], model_id="same-model", provider="same-provider")
                same_llm = FakeLlm(objects=[_l1_draft()], model_id="same-model", provider="same-provider")
                storage1 = FileStoragePort(tmp_path / "a")
                without_override = _ctx(base_llm, storage1, ComposePolicy(generatorVersion="gv1"))
                storage2 = FileStoragePort(tmp_path / "b")
                with_matching_override = _ctx(
                    base_llm, storage2, ComposePolicy(generatorVersion="gv1"), llmByTier=TierLlm(L1=same_llm)
                )
                assert tier_llm_fingerprint_material(with_matching_override) is None

                a = await compose(_INTENT_INPUT, without_override)
                b = await compose(_INTENT_INPUT, with_matching_override)
                assert a.trace.cacheKey == b.trace.cacheKey

            asyncio.run(run())

        def test_llm_by_tier_l1_different_model_separates_cache_key(self, tmp_path: Any) -> None:
            async def run() -> None:
                base_llm = FakeLlm(objects=[_l1_draft(), _l1_draft()], model_id="base-model")
                l1_llm = FakeLlm(objects=[_l1_draft()], model_id="distilled-l1-model")

                storage1 = FileStoragePort(tmp_path / "a")
                base_only = await compose(
                    _INTENT_INPUT, _ctx(base_llm, storage1, ComposePolicy(generatorVersion="gv1"))
                )
                storage2 = FileStoragePort(tmp_path / "b")
                with_l1_override = await compose(
                    _INTENT_INPUT,
                    _ctx(
                        base_llm,
                        storage2,
                        ComposePolicy(generatorVersion="gv1"),
                        llmByTier=TierLlm(L1=l1_llm),
                    ),
                )

                assert base_only.trace.cacheKey != with_l1_override.trace.cacheKey

            asyncio.run(run())

        def test_policy_fingerprint_empty_only_when_tier_llm_is_none_too(self) -> None:
            from kohaku.composer.context import TierLlmFingerprintMaterial, TierModelIdentity

            material = TierLlmFingerprintMaterial(l1=TierModelIdentity(provider="p", model_id="distilled"))
            with_material = policy_fingerprint(ComposePolicy(), material)
            without_material = policy_fingerprint(ComposePolicy())
            assert without_material == ""
            assert with_material != ""
            assert len(with_material) == 16
