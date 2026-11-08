"""Tests for the adapter-backend resolution (port of packages/port-contracts/test/backend.test.ts)."""

from __future__ import annotations

import pytest

from ._backend import AdapterBackend, resolve_adapter_backend


def test_prefers_an_explicit_url_from_the_environment_over_docker() -> None:
    backend = resolve_adapter_backend(
        "redis", {"KOHAKU_TEST_REDIS_URL": "redis://localhost:6379/1"}, lambda: True
    )
    assert backend == AdapterBackend("url", url="redis://localhost:6379/1")


def test_falls_back_to_a_container_when_docker_is_available_and_no_url_is_set() -> None:
    assert resolve_adapter_backend("postgres", {}, lambda: True) == AdapterBackend("container")


def test_skips_with_a_reason_when_neither_a_url_nor_docker_is_available() -> None:
    backend = resolve_adapter_backend("postgres", {}, lambda: False)
    assert backend.mode == "skip"
    assert "KOHAKU_TEST_POSTGRES_URL" in backend.reason


def test_raises_instead_of_skipping_when_adapter_tests_are_required() -> None:
    with pytest.raises(RuntimeError, match="KOHAKU_ADAPTER_TESTS=require"):
        resolve_adapter_backend("redis", {"KOHAKU_ADAPTER_TESTS": "require"}, lambda: False)


def test_never_probes_docker_when_a_url_is_present() -> None:
    probed: list[bool] = []

    def probe() -> bool:
        probed.append(True)
        return True

    resolve_adapter_backend("postgres", {"KOHAKU_TEST_POSTGRES_URL": "postgres://x"}, probe)
    assert probed == []


def test_adapter_tests_skip_short_circuits_before_the_url_and_the_probe() -> None:
    probed: list[bool] = []

    def probe() -> bool:
        probed.append(True)
        return True

    backend = resolve_adapter_backend(
        "redis", {"KOHAKU_ADAPTER_TESTS": "skip", "KOHAKU_TEST_REDIS_URL": "redis://x"}, probe
    )
    assert backend.mode == "skip"
    assert probed == []
