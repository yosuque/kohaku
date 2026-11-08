"""Tests for kohaku.storage.redis.connection and the fail-fast behaviour of the Redis adapters (port of
packages/storage-redis/test/connection.test.ts, fail-fast.test.ts and revocation-fail-fast.test.ts).

Docker-free: an unreachable address and fake pings stand in for the backend. The TS tests of ioredis-specific
machinery (the `error` event listener / `onError`, `maxRetriesPerRequest`, the quit-then-disconnect fallback) have no
counterpart: redis-py raises from the failing command instead of emitting an event, and has no offline queue.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest
from redis.asyncio import Redis

from kohaku.storage.redis import (
    create_redis_connection,
    create_redis_revocation_store,
    create_redis_storage_port,
)

UNREACHABLE_URL = "redis://127.0.0.1:1"
CONNECT_TIMEOUT_MS = 200
RACE_BUDGET_S = 2.0


def run(coro: Any) -> None:
    asyncio.run(coro)


class TestOptionValidation:
    def test_rejects_passing_both_url_and_client(self) -> None:
        client = Redis.from_url("redis://x", decode_responses=True)
        with pytest.raises(ValueError, match="pass either `url` or `client`, not both"):
            create_redis_connection(url="redis://x", client=client, label="test")

    def test_rejects_passing_neither_url_nor_client(self) -> None:
        with pytest.raises(ValueError, match=r"one of `url` or `client` is required"):
            create_redis_connection(label="test")

    def test_rejects_an_injected_client_without_decode_responses(self) -> None:
        client = Redis.from_url("redis://x")
        with pytest.raises(ValueError, match="decode_responses=True"):
            create_redis_connection(client=client, label="test")


class TestOwnedClientConstruction:
    def test_passes_the_connect_and_command_timeouts_through_and_decodes_responses(self) -> None:
        connection = create_redis_connection(
            url="redis://example/0", connect_timeout_ms=1234, command_timeout_ms=5678, label="test"
        )
        kwargs = connection.redis.connection_pool.connection_kwargs
        assert connection.owned is True
        assert kwargs["socket_connect_timeout"] == pytest.approx(1.234)
        assert kwargs["socket_timeout"] == pytest.approx(5.678)
        assert kwargs["decode_responses"] is True

    def test_applies_the_documented_defaults_when_timeouts_are_omitted(self) -> None:
        connection = create_redis_connection(url="redis://example/0", label="test")
        kwargs = connection.redis.connection_pool.connection_kwargs
        assert kwargs["socket_connect_timeout"] == 5.0
        assert kwargs["socket_timeout"] == 5.0

    def test_close_ends_an_owned_client(self) -> None:
        async def go() -> None:
            connection = create_redis_connection(url="redis://example/0", label="test")
            redis_client: Any = connection.redis
            closed: list[bool] = []

            async def fake_aclose() -> None:
                closed.append(True)

            redis_client.aclose = fake_aclose
            await connection.close()
            assert closed == [True]

        run(go())

    def test_never_touches_an_injected_clients_lifecycle(self) -> None:
        async def go() -> None:
            client: Any = Redis.from_url("redis://example/0", decode_responses=True)
            closed: list[bool] = []

            async def fake_aclose() -> None:
                closed.append(True)

            client.aclose = fake_aclose
            connection = create_redis_connection(client=client, label="test")
            assert connection.owned is False
            assert connection.redis is client
            await connection.close()
            assert closed == []

        run(go())


class TestReady:
    def test_a_failed_ready_is_not_remembered_and_the_next_call_retries(self) -> None:
        async def go() -> None:
            client: Any = Redis.from_url("redis://example/0", decode_responses=True)
            attempts: list[int] = []

            async def flaky_ping() -> bool:
                attempts.append(1)
                if len(attempts) == 1:
                    raise ConnectionError("down")
                return True

            client.ping = flaky_ping
            connection = create_redis_connection(client=client, label="test label")
            with pytest.raises(RuntimeError, match="test label is not ready: down"):
                await connection.ready()
            await connection.ready()
            await connection.ready()  # remembered after the success: no third ping
            assert len(attempts) == 2

        run(go())

    def test_a_ping_that_never_answers_is_bounded_by_the_connect_timeout(self) -> None:
        async def go() -> None:
            client: Any = Redis.from_url("redis://example/0", decode_responses=True)

            async def hanging_ping() -> bool:
                await asyncio.sleep(60)
                return True

            client.ping = hanging_ping
            connection = create_redis_connection(
                client=client, connect_timeout_ms=100, label="test"
            )
            started = time.monotonic()
            with pytest.raises(RuntimeError, match="test is not ready"):
                await connection.ready()
            assert time.monotonic() - started < RACE_BUDGET_S

        run(go())


class TestFailFastAgainstAnUnreachableRedis:
    def test_storage_port_ready_rejects_within_the_budget_instead_of_hanging(self) -> None:
        async def go() -> None:
            port = create_redis_storage_port(
                url=UNREACHABLE_URL, connect_timeout_ms=CONNECT_TIMEOUT_MS
            )
            try:
                started = time.monotonic()
                with pytest.raises(RuntimeError, match=r"redis storage port is not ready"):
                    await port.ready()
                assert time.monotonic() - started < RACE_BUDGET_S
            finally:
                await port.close()

        run(go())

    def test_storage_port_get_spec_cache_fails_with_the_same_not_ready_story(self) -> None:
        async def go() -> None:
            port = create_redis_storage_port(
                url=UNREACHABLE_URL, connect_timeout_ms=CONNECT_TIMEOUT_MS
            )
            try:
                started = time.monotonic()
                with pytest.raises(RuntimeError, match=r"redis storage port is not ready"):
                    await port.get_spec_cache("some-key")
                assert time.monotonic() - started < RACE_BUDGET_S
            finally:
                await port.close()

        run(go())

    def test_revocation_store_methods_fail_fast_with_the_not_ready_story(self) -> None:
        async def go() -> None:
            store = create_redis_revocation_store(
                url=UNREACHABLE_URL, connect_timeout_ms=CONNECT_TIMEOUT_MS
            )
            try:
                started = time.monotonic()
                with pytest.raises(RuntimeError, match=r"redis revocation store is not ready"):
                    await store.ready()
                with pytest.raises(RuntimeError, match=r"redis revocation store is not ready"):
                    await store.is_revoked("some-jti")
                with pytest.raises(RuntimeError, match=r"redis revocation store is not ready"):
                    await store.revoke("some-jti", int(time.time()) + 3600)
                assert time.monotonic() - started < RACE_BUDGET_S
            finally:
                await store.close()

        run(go())
