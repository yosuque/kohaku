"""Tests for sales_api.storage_from_env (the storage half of TS apps/sample-api/src/ports/from-env.ts): the
KOHAKU_STORAGE selection, its required variables and error messages, and the refusal of the public demo secret next to
a shared backend. The adapters themselves are tested in kohaku/tests/storage; here nothing connects to a backend."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from kohaku.storage import FileStoragePort, MemoryStoragePort
from sales_api.storage_from_env import (
    DEV_CAPABILITY_SECRET,
    capability_secret_from_env,
    create_storage_from_env,
    storage_kind_from_env,
)


class TestStorageKind:
    def test_defaults_to_file(self) -> None:
        assert storage_kind_from_env({}) == "file"

    @pytest.mark.parametrize("kind", ["file", "memory", "redis", "postgres"])
    def test_accepts_every_documented_kind(self, kind: str) -> None:
        assert storage_kind_from_env({"KOHAKU_STORAGE": kind}) == kind

    def test_rejects_an_unknown_kind_naming_the_choices(self) -> None:
        with pytest.raises(
            ValueError,
            match=r'KOHAKU_STORAGE must be one of file / memory / redis / postgres, got "sqlite"',
        ):
            storage_kind_from_env({"KOHAKU_STORAGE": "sqlite"})


class TestCreateStorageFromEnv:
    def test_file_storage_is_the_default_and_needs_no_connection(self, tmp_path: Path) -> None:
        async def go() -> None:
            backend = create_storage_from_env({}, data_dir=tmp_path)
            assert backend.kind == "file"
            assert isinstance(backend.storage, FileStoragePort)
            await backend.ready()
            await backend.close()
            assert await backend.revocations.is_revoked("never") is False

        asyncio.run(go())

    def test_memory_storage_is_ephemeral(self, tmp_path: Path) -> None:
        backend = create_storage_from_env({"KOHAKU_STORAGE": "memory"}, data_dir=tmp_path)
        assert backend.kind == "memory"
        assert isinstance(backend.storage, MemoryStoragePort)

    def test_redis_requires_its_url(self, tmp_path: Path) -> None:
        with pytest.raises(
            ValueError, match="KOHAKU_REDIS_URL is required when KOHAKU_STORAGE=redis"
        ):
            create_storage_from_env({"KOHAKU_STORAGE": "redis"}, data_dir=tmp_path)

    def test_postgres_requires_its_url(self, tmp_path: Path) -> None:
        with pytest.raises(
            ValueError, match="KOHAKU_POSTGRES_URL is required when KOHAKU_STORAGE=postgres"
        ):
            create_storage_from_env({"KOHAKU_STORAGE": "postgres"}, data_dir=tmp_path)

    def test_redis_builds_a_port_that_declares_compare_and_set_without_connecting(
        self, tmp_path: Path
    ) -> None:
        backend = create_storage_from_env(
            {"KOHAKU_STORAGE": "redis", "KOHAKU_REDIS_URL": "redis://127.0.0.1:1"},
            data_dir=tmp_path,
        )
        assert backend.kind == "redis"
        assert getattr(backend.storage, "supports_compare_and_set", False) is True

    def test_postgres_builds_a_port_that_declares_compare_and_set_without_connecting(
        self, tmp_path: Path
    ) -> None:
        backend = create_storage_from_env(
            {
                "KOHAKU_STORAGE": "postgres",
                "KOHAKU_POSTGRES_URL": "postgresql://127.0.0.1:1/db",
                "KOHAKU_POSTGRES_SCHEMA": "kohaku_sample",
            },
            data_dir=tmp_path,
        )
        assert backend.kind == "postgres"
        assert getattr(backend.storage, "supports_compare_and_set", False) is True


class TestCapabilitySecret:
    def test_the_demo_default_is_fine_for_single_process_storage(self) -> None:
        assert capability_secret_from_env({}) == DEV_CAPABILITY_SECRET
        assert capability_secret_from_env({"KOHAKU_STORAGE": "memory"}) == DEV_CAPABILITY_SECRET

    @pytest.mark.parametrize("raw", [None, "", "   "])
    @pytest.mark.parametrize("kind", ["redis", "postgres"])
    def test_a_shared_backend_refuses_the_public_demo_secret(
        self, kind: str, raw: str | None
    ) -> None:
        env = {"KOHAKU_STORAGE": kind}
        if raw is not None:
            env["KOHAKU_CAPABILITY_SECRET"] = raw
        with pytest.raises(ValueError, match="must be set to a real secret"):
            capability_secret_from_env(env)

    def test_a_real_secret_is_returned_untrimmed(self) -> None:
        env = {"KOHAKU_STORAGE": "redis", "KOHAKU_CAPABILITY_SECRET": " s3cret "}
        assert capability_secret_from_env(env) == " s3cret "
