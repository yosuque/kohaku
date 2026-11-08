"""The CapabilityRevocationStore contract and Redis-specific behaviour of the Redis store (port of
packages/storage-redis/test/revocation-contract.test.ts and revocation.test.ts; the fail-fast cases live in
test_redis_connection.py)."""

from __future__ import annotations

import asyncio
import secrets
import time
from typing import Any, cast

import pytest
from redis.asyncio import Redis

from kohaku.spec import CapabilityRevocationStore
from kohaku.storage.redis import create_redis_revocation_store

from ..authz_hmac._contract import RevocationStoreContract


def _prefix() -> str:
    return f"t{secrets.token_hex(6)}"


class TestRedisRevocationStoreContract(RevocationStoreContract):
    """The shared contract, against a real Redis (skipped without one)."""

    @pytest.fixture(autouse=True)
    def _backend(self, redis_url: str) -> None:
        self.url = redis_url

    def make_store(self) -> CapabilityRevocationStore:
        return create_redis_revocation_store(url=self.url, key_prefix=_prefix())

    async def close_store(self, store: CapabilityRevocationStore) -> None:
        await cast(Any, store).close()


class TestRedisRevocationStore:
    def test_revoke_sets_a_key_with_an_ex_derived_from_expiry_minus_now(
        self, redis_url: str
    ) -> None:
        async def go() -> None:
            prefix = _prefix()
            store = create_redis_revocation_store(url=redis_url, key_prefix=prefix)
            client = Redis.from_url(redis_url, decode_responses=True)
            try:
                expires_at = int(time.time()) + 3600
                await store.revoke("some-jti", expires_at)
                assert await store.is_revoked("some-jti") is True
                assert await store.is_revoked("never-registered-jti") is False
                ttl = await client.ttl(f"{prefix}:revoked:some-jti")
                # Slack for wall-clock drift between the two clock reads.
                assert 3500 < ttl <= 3600
            finally:
                await client.aclose()
                await store.close()

        asyncio.run(go())

    def test_revoke_is_a_no_op_when_expiry_is_already_at_or_before_now(
        self, redis_url: str
    ) -> None:
        async def go() -> None:
            prefix = _prefix()
            store = create_redis_revocation_store(url=redis_url, key_prefix=prefix)
            client = Redis.from_url(redis_url, decode_responses=True)
            try:
                await store.revoke("expired-jti", int(time.time()) - 10)
                assert await store.is_revoked("expired-jti") is False
                assert await client.exists(f"{prefix}:revoked:expired-jti") == 0
            finally:
                await client.aclose()
                await store.close()

        asyncio.run(go())

    def test_a_revocation_is_visible_through_a_second_store_on_the_same_backend(
        self, redis_url: str
    ) -> None:
        async def go() -> None:
            prefix = _prefix()
            a = create_redis_revocation_store(url=redis_url, key_prefix=prefix)
            b = create_redis_revocation_store(url=redis_url, key_prefix=prefix)
            try:
                await a.revoke("shared-jti", int(time.time()) + 60)
                assert await b.is_revoked("shared-jti") is True
            finally:
                await a.close()
                await b.close()

        asyncio.run(go())
