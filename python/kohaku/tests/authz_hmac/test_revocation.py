"""Capability revocation tests (port of TS: packages/authz-hmac/test/revocation.test.ts and
memory-revocation-store.test.ts)."""

from __future__ import annotations

import asyncio
import json

from kohaku.authz_hmac import create_hmac_authz_port, create_memory_revocation_store
from kohaku.authz_hmac.authz_port import b64url_encode
from kohaku.authz_hmac.revocation_store import MemoryRevocationStore
from kohaku.spec import Principal, Scope, VerifyRequest

PRINCIPAL = Principal(id="u", roles=["user"])
SCOPES = [Scope(kind="read", ref="query://s/x")]
REQ = VerifyRequest(kind="read", ref="query://s/x")
EPOCH = 1_767_225_600.0  # 2026-01-01T00:00:00Z


def _pre_upgrade_token(secret: str, exp: int) -> str:
    """A token with the same wire shape as the port's, but without a jti (a capability minted by a
    pre-upgrade instance during a rolling deploy)."""
    import hashlib
    import hmac

    claims = {"sub": PRINCIPAL.id, "scopes": [{"kind": "read", "ref": "query://s/x"}], "exp": exp}
    payload = b64url_encode(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
    digest = hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).digest()
    return f"{payload}.{b64url_encode(digest)}"


class _Store:
    """A scripted revocation store recording its calls."""

    def __init__(self, *, fail_revoke: bool = False) -> None:
        self.calls: list[str] = []
        self.revoked: set[str] = set()
        self._fail_revoke = fail_revoke

    async def revoke(self, jti: str, expires_at: int) -> None:
        self.calls.append(f"revoke:{jti}")
        if self._fail_revoke:
            raise RuntimeError("store unavailable (test)")
        self.revoked.add(jti)

    async def is_revoked(self, jti: str) -> bool:
        self.calls.append(f"is_revoked:{jti}")
        return jti in self.revoked


class TestCapabilityRevocation:
    def test_verifies_ok_then_reports_revoked_once_revoke_capability_has_been_called(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            cap = await authz.issue_capability(PRINCIPAL, SCOPES)
            assert (await authz.verify(cap, REQ)).ok is True

            revoked = await authz.revoke_capability(cap)
            assert (revoked.ok, revoked.code, revoked.already_expired) == (True, None, False)

            result = await authz.verify(cap, REQ)
            assert (result.ok, result.reason) == (False, "capability revoked")

        asyncio.run(run())

    def test_rejects_revocation_of_a_tampered_or_foreign_token(self) -> None:
        """The signature is verified first, so a caller cannot revoke a jti it merely guessed."""

        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            cap = await authz.issue_capability(PRINCIPAL, SCOPES)
            tampered = cap[:-2] + ("BB" if cap.endswith("AA") else "AA")
            result = await authz.revoke_capability(tampered)
            assert (result.ok, result.code) == (False, "INVALID_SIGNATURE")

            # A forged token signed with a different secret must also be rejected, not merely "not found".
            foreign = await create_hmac_authz_port("other-secret").issue_capability(
                PRINCIPAL, SCOPES
            )
            foreign_result = await authz.revoke_capability(foreign)
            assert (foreign_result.ok, foreign_result.code) == (False, "INVALID_SIGNATURE")

        asyncio.run(run())

    def test_rejects_revocation_of_a_malformed_token_with_no_signature_separator(self) -> None:
        async def run() -> None:
            result = await create_hmac_authz_port("test-secret").revoke_capability("not-a-token")
            assert (result.ok, result.code, result.reason) == (
                False,
                "MALFORMED",
                "malformed token",
            )

        asyncio.run(run())

    def test_verifies_a_jti_less_pre_upgrade_token_ok_but_cannot_revoke_it(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret", now=lambda: EPOCH)
            legacy = _pre_upgrade_token("test-secret", int(EPOCH) + 3600)
            assert (await authz.verify(legacy, REQ)).ok is True

            result = await authz.revoke_capability(legacy)
            assert (result.ok, result.code, result.reason) == (
                False,
                "NO_JTI",
                "token predates revocation support",
            )
            # The failed revoke must not have broken anything.
            assert (await authz.verify(legacy, REQ)).ok is True

        asyncio.run(run())

    def test_reports_an_already_expired_tokens_revocation_as_idempotent_success_without_a_store_write(
        self,
    ) -> None:
        async def run() -> None:
            clock = {"t": EPOCH}
            store = _Store()
            authz = create_hmac_authz_port("test-secret", revocation=store, now=lambda: clock["t"])
            cap = await authz.issue_capability(PRINCIPAL, SCOPES, ttl_seconds=1)
            clock["t"] = EPOCH + 2

            result = await authz.revoke_capability(cap)
            assert (result.ok, result.already_expired) == (True, True)
            assert store.calls == []

        asyncio.run(run())

    def test_reports_already_expired_exactly_at_the_expiry_instant(self) -> None:
        """exp <= now, not exp < now."""

        async def run() -> None:
            clock = {"t": EPOCH}
            authz = create_hmac_authz_port("test-secret", now=lambda: clock["t"])
            cap = await authz.issue_capability(PRINCIPAL, SCOPES, ttl_seconds=1)
            clock["t"] = EPOCH + 1

            result = await authz.revoke_capability(cap)
            assert (result.ok, result.already_expired) == (True, True)

        asyncio.run(run())

    def test_maps_a_revocation_store_failure_to_a_coded_store_error_without_raising(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret", revocation=_Store(fail_revoke=True))
            cap = await authz.issue_capability(PRINCIPAL, SCOPES)

            result = await authz.revoke_capability(cap)
            assert (result.ok, result.code) == (False, "STORE_ERROR")
            assert result.reason is not None and "store unavailable (test)" in result.reason

        asyncio.run(run())

    def test_actually_consults_an_injected_revocation_store(self) -> None:
        async def run() -> None:
            store = _Store()
            authz = create_hmac_authz_port("test-secret", revocation=store)
            cap = await authz.issue_capability(PRINCIPAL, SCOPES)

            await authz.verify(cap, REQ)
            await authz.revoke_capability(cap)
            result = await authz.verify(cap, REQ)

            assert result.ok is False
            assert any(c.startswith("is_revoked:") for c in store.calls)
            assert any(c.startswith("revoke:") for c in store.calls)

        asyncio.run(run())

    def test_an_approval_token_cannot_be_revoked_as_a_capability(self) -> None:
        """TS approval-port.test.ts: an approval token's signature does not verify under the capability key."""

        async def run() -> None:
            from kohaku.authz_hmac import create_hmac_approval_port

            token = await create_hmac_approval_port("test-secret").issue_approval(
                action="annotate",
                payload_hash="sha256:" + "a" * 64,
                requester_id="r",
                approver_id="a",
            )
            stripped = token[token.index(".", token.index(".") + 1) + 1 :]
            authz = create_hmac_authz_port("test-secret")
            verified = await authz.verify(stripped, VerifyRequest(kind="write", ref="annotate"))
            assert (verified.ok, verified.reason) == (False, "invalid signature")
            revoked = await authz.revoke_capability(stripped)
            assert (revoked.ok, revoked.code) == (False, "INVALID_SIGNATURE")

        asyncio.run(run())


class TestMemoryRevocationStoreCleanup:
    """Implementation-specific behavior (not part of the shared contract): the in-memory store actually drops
    expired entries so its size stays bounded by the number of not-yet-expired revoked tokens."""

    def test_sweeps_an_expired_entry_out_on_the_next_revoke_call(self) -> None:
        async def run() -> None:
            clock = {"t": EPOCH}
            store = create_memory_revocation_store(lambda: clock["t"])

            await store.revoke("short-lived", int(EPOCH) + 1)
            assert await store.is_revoked("short-lived") is True

            clock["t"] = EPOCH + 2
            assert await store.is_revoked("short-lived") is False

            await store.revoke("another", int(clock["t"]) + 3600)
            assert await store.is_revoked("short-lived") is False
            assert await store.is_revoked("another") is True

        asyncio.run(run())

    def test_actually_evicts_an_expired_entry_from_the_backing_map_on_revoke(self) -> None:
        """Inspects the backing map without an intervening is_revoked call (which would itself delete an
        expired entry as a side effect), so deleting the sweep from revoke() makes this assertion fail."""

        async def run() -> None:
            clock = {"t": EPOCH}
            store = MemoryRevocationStore(lambda: clock["t"])

            await store.revoke("short-lived", int(EPOCH) + 1)
            assert len(store._revoked) == 1

            clock["t"] = EPOCH + 2
            await store.revoke("another", int(clock["t"]) + 3600)

            assert "short-lived" not in store._revoked
            assert "another" in store._revoked
            assert len(store._revoked) == 1

        asyncio.run(run())
