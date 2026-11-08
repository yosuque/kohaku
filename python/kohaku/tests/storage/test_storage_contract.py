"""Runs the StoragePort contract (`_contract.py`) against every adapter: memory, file, redis, postgres (the Python
mirror of the TS suites that call `describeStoragePortContract` for storage-memory / storage-redis /
storage-postgres). The Redis / Postgres variants skip without a backend (see `_backend.py`); with
``KOHAKU_ADAPTER_TESTS=require`` a missing backend fails instead.

pytest's parametrize crosses the adapter fixture with the case list, so a failure reads
``test_storage_contract[postgres-compare-and-set: ...]``. Each case gets a fresh port (a fresh temp directory / key
prefix / schema) and runs in its own ``asyncio.run`` loop, with the port created and closed inside that loop.
"""

from __future__ import annotations

import asyncio
import secrets
import tempfile
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from pathlib import Path
from typing import Any

import pytest

from kohaku.spec import is_single_process, supports_compare_and_set
from kohaku.storage import FileStoragePort, MemoryStoragePort
from kohaku.storage.postgres import create_postgres_storage_port
from kohaku.storage.redis import create_redis_storage_port

from ._contract import CASES, ContractCase

type PortOpener = Callable[[], AbstractAsyncContextManager[Any]]


def _unique(prefix: str) -> str:
    return f"{prefix}{secrets.token_hex(6)}"


@pytest.fixture(params=["memory", "file", "redis", "postgres"])
def adapter(request: pytest.FixtureRequest) -> str:
    return str(request.param)


@pytest.fixture
def open_port(request: pytest.FixtureRequest, tmp_path: Path, adapter: str) -> PortOpener:
    """A factory for one fresh port of the adapter under test (an async context manager that closes it)."""

    if adapter == "memory":

        @asynccontextmanager
        async def memory() -> AsyncIterator[Any]:
            port = MemoryStoragePort()
            try:
                yield port
            finally:
                port.close()

        return memory

    if adapter == "file":

        @asynccontextmanager
        async def file() -> AsyncIterator[Any]:
            # A new directory per case: the file port reloads its snapshots from disk.
            with tempfile.TemporaryDirectory(dir=tmp_path) as data_dir:
                yield FileStoragePort(data_dir)

        return file

    if adapter == "redis":
        url: str = request.getfixturevalue("redis_url")

        @asynccontextmanager
        async def redis() -> AsyncIterator[Any]:
            port = create_redis_storage_port(url=url, key_prefix=_unique("t"))
            try:
                yield port
            finally:
                await port.close()

        return redis

    if adapter == "postgres":
        connection_string: str = request.getfixturevalue("postgres_url")

        @asynccontextmanager
        async def postgres() -> AsyncIterator[Any]:
            port = create_postgres_storage_port(
                connection_string=connection_string, schema=_unique("t")
            )
            try:
                yield port
            finally:
                await port.close()

        return postgres

    raise AssertionError(f"unknown adapter {adapter}")


SHARED_BACKEND_ADAPTERS = ("redis", "postgres")
"""Adapters that serve several host instances and therefore MUST declare compare-and-set (the TS suites opt in with
`requireCompareAndSet` for exactly these)."""


@pytest.mark.parametrize("case", CASES, ids=[c.name for c in CASES])
def test_storage_contract(open_port: PortOpener, adapter: str, case: ContractCase) -> None:
    async def go() -> None:
        async with open_port() as port:
            if case.requires_compare_and_set and not supports_compare_and_set(port):
                if adapter in SHARED_BACKEND_ADAPTERS:
                    pytest.fail(f"{adapter} must declare supports_compare_and_set")
                pytest.skip(f"{adapter} does not declare compare-and-set (single process)")
            await case.run(port)

    asyncio.run(go())


def test_adapters_declare_their_concurrency_story(open_port: PortOpener, adapter: str) -> None:
    """memory / file mark themselves `single_process` (no cross-process guarantee to declare, so a host does not
    warn); redis / postgres serve several host instances, so they declare compare-and-set instead and are never
    `single_process` (TS: `singleProcess` / `supportsCompareAndSet`)."""

    async def go() -> None:
        async with open_port() as port:
            if adapter in SHARED_BACKEND_ADAPTERS:
                assert supports_compare_and_set(port)
                assert not is_single_process(port)
            else:
                assert is_single_process(port)

    asyncio.run(go())
