"""Regression coverage for SPEC CMP-DET-002 (port of
packages/composer/test/tenant-cache-isolation.test.ts).

"A cache entry only reachable via L2 MUST NOT be returned to a session that has L2 disabled" -- the
invariant the tierGate policy_fingerprint row (context.py, Policy as Code) exists to guarantee. `tenant`
itself is never part of the cache key (SPEC §6.1: `query://` is tenant-neutral) -- before this row
existed, `allowL2` was not part of the key either, so two sessions differing only in `allowL2` for the
identical intent/dataVersion/catalogFingerprint would collide on the same Spec-cache entry.
"""

from __future__ import annotations

import asyncio
from typing import Any

from kohaku.composer import ComposeContext, ComposeOptions, ComposePolicy, compose
from kohaku.llm import FakeLlm
from kohaku.spec import SessionContext
from kohaku.storage import FileStoragePort

from .test_compose import _CATALOG, _INTENT_INPUT, _L2_HTML, _FakeSemantic, _l1_draft


def test_disallowed_l2_tenant_never_receives_another_tenants_cached_l2_spec(tmp_path: Any) -> None:
    async def run() -> None:
        # Same storage (Spec cache) is shared by both tenants on purpose -- this is exactly the scenario
        # a real host is in: one Spec cache, `tenant` narrowed only via DomainPort/capability (§2.3/§5),
        # never via the cache key.
        storage = FileStoragePort(tmp_path)
        semantic = _FakeSemantic()

        # tenant-b: allowL2 true, routed straight to L2.
        tenant_b_ctx = ComposeContext(
            catalog=_CATALOG,
            semantic=semantic,
            storage=storage,
            llm=FakeLlm(texts=[_L2_HTML]),
            policy=ComposePolicy(allowL2=True, routeTier=lambda _i: "L2"),
        )
        result_b = await compose(
            _INTENT_INPUT, tenant_b_ctx, ComposeOptions(session=SessionContext(surface="web", tenant="tenant-b"))
        )
        assert result_b.trace.tier == "L2"
        assert any(c.type == "sandbox.html" for c in result_b.spec.components)

        # tenant-a: allowL2 false, the SAME intent otherwise, sharing the SAME storage/Spec cache.
        tenant_a_ctx = ComposeContext(
            catalog=_CATALOG,
            semantic=semantic,
            storage=storage,
            llm=FakeLlm(objects=[_l1_draft()]),
            policy=ComposePolicy(allowL2=False),
        )
        result_a = await compose(
            _INTENT_INPUT, tenant_a_ctx, ComposeOptions(session=SessionContext(surface="web", tenant="tenant-a"))
        )

        # Must NOT be a cache hit against tenant-b's L2 entry: distinct cache keys (the tierGate
        # fingerprint differs), a genuine L1 generation actually ran, and the delivered Spec carries no
        # L2 component.
        assert result_a.trace.cacheKey != result_b.trace.cacheKey
        assert result_a.trace.cache == "miss"
        assert result_a.trace.tier == "L1"
        assert not any(c.type == "sandbox.html" for c in result_a.spec.components)

    asyncio.run(run())


def test_two_tenants_with_the_identical_tier_gate_shape_share_a_cache_entry(tmp_path: Any) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        semantic = _FakeSemantic()
        policy = ComposePolicy(allowL2=True, routeTier=lambda _i: "L2")

        first_ctx = ComposeContext(
            catalog=_CATALOG, semantic=semantic, storage=storage, llm=FakeLlm(texts=[_L2_HTML]), policy=policy
        )
        first = await compose(
            _INTENT_INPUT, first_ctx, ComposeOptions(session=SessionContext(surface="web", tenant="tenant-b"))
        )
        assert first.trace.cache == "miss"

        second_ctx = ComposeContext(
            catalog=_CATALOG, semantic=semantic, storage=storage, llm=FakeLlm(texts=[_L2_HTML]), policy=policy
        )
        second = await compose(
            _INTENT_INPUT, second_ctx, ComposeOptions(session=SessionContext(surface="web", tenant="tenant-c"))
        )
        assert second.trace.cache == "hit"
        assert second.trace.cacheKey == first.trace.cacheKey

    asyncio.run(run())
