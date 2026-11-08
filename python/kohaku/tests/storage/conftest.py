"""Session fixtures that hand the Redis / Postgres test suites their backend URL (see `_backend.py` for the
resolution order). Only the URL is session-scoped: every test runs its own ``asyncio.run`` loop, and a redis-py
client or psycopg pool created in one loop is dead in the next, so each test builds (and closes) its own port from
the URL inside its own loop -- mirroring the TS suites, whose factory runs in ``beforeEach``."""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import ExitStack

import pytest

from ._backend import (
    AdapterBackend,
    AdapterBackendKind,
    docker_available,
    postgres_container,
    redis_container,
    resolve_adapter_backend,
)

_docker_probe_result: bool | None = None


def _docker_probe() -> bool:
    """One `docker info` per session, shared by both backends (the TS suites share one probe through a vitest
    globalSetup for the same reason)."""
    global _docker_probe_result
    if _docker_probe_result is None:
        _docker_probe_result = docker_available()
    return _docker_probe_result


def _url_for(kind: AdapterBackendKind, stack: ExitStack) -> str:
    backend: AdapterBackend = resolve_adapter_backend(kind, os.environ, _docker_probe)
    if backend.mode == "skip":
        pytest.skip(backend.reason)
    if backend.mode == "url":
        return backend.url
    return stack.enter_context(redis_container() if kind == "redis" else postgres_container())


@pytest.fixture(scope="session")
def redis_url() -> Iterator[str]:
    with ExitStack() as stack:
        yield _url_for("redis", stack)


@pytest.fixture(scope="session")
def postgres_url() -> Iterator[str]:
    with ExitStack() as stack:
        yield _url_for("postgres", stack)
