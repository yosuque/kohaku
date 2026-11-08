"""The CapabilityRevocationStore contract and Postgres-specific behaviour of the Postgres store (port of
packages/storage-postgres/test/revocation-contract.test.ts and revocation.test.ts)."""

from __future__ import annotations

import asyncio
import secrets
import time
from typing import Any, cast

import pytest

from kohaku.spec import CapabilityRevocationStore
from kohaku.storage.postgres import create_postgres_revocation_store

from ..authz_hmac._contract import RevocationStoreContract


def _schema() -> str:
    return f"t{secrets.token_hex(6)}"


class TestPostgresRevocationStoreContract(RevocationStoreContract):
    """The shared contract, against a real Postgres (skipped without one)."""

    @pytest.fixture(autouse=True)
    def _backend(self, postgres_url: str) -> None:
        self.url = postgres_url

    def make_store(self) -> CapabilityRevocationStore:
        return create_postgres_revocation_store(connection_string=self.url, schema=_schema())

    async def close_store(self, store: CapabilityRevocationStore) -> None:
        await cast(Any, store).close()


class TestPostgresRevocationStore:
    def test_is_revoked_reports_false_for_a_past_expiry_before_any_sweep(
        self, postgres_url: str
    ) -> None:
        async def go() -> None:
            store = create_postgres_revocation_store(
                connection_string=postgres_url, schema=_schema()
            )
            try:
                await store.revoke("born-expired", int(time.time()) - 3600)
                # No sweep: `is_revoked`'s own `expires_at > now()` filter must already treat the row as not
                # revoked, independent of the sweep cron ever running.
                assert await store.is_revoked("born-expired") is False
            finally:
                await store.close()

        asyncio.run(go())

    def test_revoke_upserts_revoking_the_same_jti_again_updates_its_expiry(
        self, postgres_url: str
    ) -> None:
        async def go() -> None:
            store = create_postgres_revocation_store(
                connection_string=postgres_url, schema=_schema()
            )
            try:
                now = int(time.time())
                await store.revoke("dup-jti", now + 60)
                await store.revoke("dup-jti", now + 3600)
                assert await store.is_revoked("dup-jti") is True
            finally:
                await store.close()

        asyncio.run(go())

    def test_sweep_deletes_rows_whose_expiry_has_passed_and_returns_the_row_count(
        self, postgres_url: str
    ) -> None:
        async def go() -> None:
            store = create_postgres_revocation_store(
                connection_string=postgres_url, schema=_schema()
            )
            try:
                now = int(time.time())
                await store.revoke("sweep-me", now - 10)
                await store.revoke("keep-me", now + 3600)
                assert await store.sweep_expired_revocations() == 1
                assert await store.is_revoked("keep-me") is True
            finally:
                await store.close()

        asyncio.run(go())

    def test_a_revocation_is_visible_through_a_second_store_on_the_same_schema(
        self, postgres_url: str
    ) -> None:
        async def go() -> None:
            schema = _schema()
            a = create_postgres_revocation_store(connection_string=postgres_url, schema=schema)
            b = create_postgres_revocation_store(connection_string=postgres_url, schema=schema)
            try:
                await a.revoke("shared-jti", int(time.time()) + 60)
                assert await b.is_revoked("shared-jti") is True
            finally:
                await a.close()
                await b.close()

        asyncio.run(go())
