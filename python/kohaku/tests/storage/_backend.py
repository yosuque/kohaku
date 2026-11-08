"""How a backend-backed test suite (Redis / Postgres) finds its backend (Python mirror of the TS
`@kohaku-ui/port-contracts` `resolveAdapterBackend`, packages/port-contracts/src/backend.ts).

Three tiers, in order:

1. an explicit URL in the environment (``KOHAKU_TEST_REDIS_URL`` / ``KOHAKU_TEST_POSTGRES_URL`` -- the same
   variable names as the TS suites, so one CI job service feeds both languages);
2. a Docker daemon -- the suite starts a throwaway container via testcontainers;
3. neither -- the suite is skipped, so a plain ``uv run pytest`` on a laptop without Docker stays green.

``KOHAKU_ADAPTER_TESTS=require`` turns tier 3 into a failure, so a CI job that is supposed to exercise the adapters
can never pass by silently skipping them. ``KOHAKU_ADAPTER_TESTS=skip`` is the opposite override: it short-circuits
before either tier 1 or tier 2 is consulted.
"""

from __future__ import annotations

import subprocess
import time
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Literal

AdapterBackendKind = Literal["redis", "postgres"]

_URL_ENV: dict[AdapterBackendKind, str] = {
    "redis": "KOHAKU_TEST_REDIS_URL",
    "postgres": "KOHAKU_TEST_POSTGRES_URL",
}


@dataclass(frozen=True)
class AdapterBackend:
    mode: Literal["url", "container", "skip"]
    url: str = ""
    reason: str = ""


def resolve_adapter_backend(
    kind: AdapterBackendKind,
    env: Mapping[str, str],
    docker_probe: Callable[[], bool],
) -> AdapterBackend:
    if env.get("KOHAKU_ADAPTER_TESTS") == "skip":
        return AdapterBackend("skip", reason="KOHAKU_ADAPTER_TESTS=skip")
    url = env.get(_URL_ENV[kind], "")
    if url != "":
        return AdapterBackend("url", url=url)
    if docker_probe():
        return AdapterBackend("container")
    reason = f"no {kind} backend: set {_URL_ENV[kind]} or make Docker available (testcontainers)"
    if env.get("KOHAKU_ADAPTER_TESTS") == "require":
        raise RuntimeError(f"{reason} -- KOHAKU_ADAPTER_TESTS=require forbids skipping this suite")
    return AdapterBackend("skip", reason=reason)


def docker_available() -> bool:
    """True when a Docker-compatible daemon answers ``docker info`` within 5 seconds."""
    try:
        result = subprocess.run(["docker", "info"], capture_output=True, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def _wait_until(probe: Callable[[], None], what: str, timeout_s: float = 60.0) -> None:
    deadline = time.monotonic() + timeout_s
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            probe()
            return
        except Exception as error:
            last = error
            time.sleep(0.25)
    raise RuntimeError(f"{what} did not become ready within {timeout_s:.0f}s: {last}")


@contextmanager
def redis_container() -> Iterator[str]:
    """Starts a throwaway Redis and yields its URL (the generic DockerContainer, so no testcontainers extra)."""
    from redis import Redis  # sync client, only to poll for readiness
    from testcontainers.core.container import DockerContainer

    container = DockerContainer("redis:7-alpine").with_exposed_ports(6379)
    container.start()
    try:
        url = f"redis://{container.get_container_host_ip()}:{container.get_exposed_port(6379)}"

        def probe() -> None:
            client = Redis.from_url(url, socket_connect_timeout=1)
            try:
                client.ping()
            finally:
                client.close()

        _wait_until(probe, "redis container")
        yield url
    finally:
        container.stop()


@contextmanager
def postgres_container() -> Iterator[str]:
    """Starts a throwaway Postgres and yields its URL. Readiness is polled with a real connection: the server's
    "ready to accept connections" log line appears twice (once for the init-time server that only listens on a
    unix socket), so waiting on the log alone returns too early."""
    import psycopg
    from testcontainers.core.container import DockerContainer

    container = (
        DockerContainer("postgres:16-alpine")
        .with_env("POSTGRES_PASSWORD", "postgres")
        .with_exposed_ports(5432)
    )
    container.start()
    try:
        url = (
            "postgresql://postgres:postgres@"
            f"{container.get_container_host_ip()}:{container.get_exposed_port(5432)}/postgres"
        )

        def probe() -> None:
            with psycopg.connect(url, connect_timeout=1) as conn:
                conn.execute("SELECT 1")

        _wait_until(probe, "postgres container")
        yield url
    finally:
        container.stop()
