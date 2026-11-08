"""Port contract suites for AuthzPort / ApprovalPort / CapabilityRevocationStore (Python mirror of the TS
`@kohaku-ui/port-contracts` suites `describeAuthzPortContract`, `describeApprovalPortContract` and
`describeRevocationStoreContract`).

Each suite is a plain class (not collected by pytest on its own): a test module subclasses it under a ``Test*``
name and implements ``make_port`` / ``make_store``. Where the TS suites take an opt-in option (``tenant``,
``revocation``, ``singleUse``), this module offers a separate opt-in class instead of a flag, so an adapter
that cannot carry a tenant (or revoke, or enforce single use) omits the class rather than silently passing a
suite that never exercised it -- the mistake the TS suites' own doc comments warn about.

The TS suites drive expiry with ``vi.setSystemTime``; here the factory receives a `FakeClock` and builds its
port with ``now=clock`` (the Python ports take an injectable clock), so the contract needs no global patching.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable
from typing import Protocol

import pytest

from kohaku.spec import (
    APPROVAL_ISSUE_ERROR_CODE,
    ApprovalPort,
    AuthzPort,
    CapabilityRevocationStore,
    Principal,
    RevokeCapabilityResult,
    Scope,
    VerifyRequest,
)

# 2026-01-01T00:00:00Z, the instant every TS contract suite pins with vi.setSystemTime.
CONTRACT_EPOCH = 1_767_225_600.0


class FakeClock:
    """A settable clock in epoch seconds; pass it as a port's ``now``."""

    def __init__(self, start: float = CONTRACT_EPOCH) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def run[T](coro: Awaitable[T]) -> T:
    async def _wrap() -> T:
        return await coro

    return asyncio.run(_wrap())


PRINCIPAL = Principal(id="contract-user", roles=["user"])
READ_X = [Scope(kind="read", ref="query://s/x")]
REQ_X = VerifyRequest(kind="read", ref="query://s/x")


def _tamper(token: str) -> str:
    return token[:-2] + ("BB" if token.endswith("AA") else "AA")


class AuthzPortContract:
    """The AuthzPort contract (kohaku.spec ports): exact-match scopes, tamper detection, expiry."""

    def make_port(self, clock: FakeClock) -> AuthzPort:
        raise NotImplementedError

    def test_verifies_a_capability_for_exactly_the_issued_scope_and_returns_the_principal(
        self,
    ) -> None:
        async def go() -> None:
            authz = self.make_port(FakeClock())
            scope = Scope(kind="read", ref="query://s/summary?region=us")
            cap = await authz.issue_capability(PRINCIPAL, [scope])
            result = await authz.verify(cap, VerifyRequest(kind="read", ref=scope.ref))
            assert result.ok is True
            assert result.principal is not None and result.principal.id == PRINCIPAL.id

        run(go())

    def test_matches_refs_exactly_with_no_prefix_match_across_value_or_name_boundaries(
        self,
    ) -> None:
        async def go() -> None:
            authz = self.make_port(FakeClock())
            cap = await authz.issue_capability(
                PRINCIPAL,
                [
                    Scope(kind="read", ref="query://s/summary?region=us"),
                    Scope(kind="write", ref="annotate"),
                ],
            )
            usa = VerifyRequest(kind="read", ref="query://s/summary?region=usa")
            assert (await authz.verify(cap, usa)).ok is False
            assert (
                await authz.verify(cap, VerifyRequest(kind="write", ref="annotateAll"))
            ).ok is False

        run(go())

    def test_does_not_let_a_read_scope_satisfy_a_write_request_for_the_same_ref(self) -> None:
        async def go() -> None:
            authz = self.make_port(FakeClock())
            cap = await authz.issue_capability(PRINCIPAL, [Scope(kind="read", ref="annotate")])
            assert (
                await authz.verify(cap, VerifyRequest(kind="write", ref="annotate"))
            ).ok is False

        run(go())

    def test_rejects_a_tampered_or_malformed_token(self) -> None:
        async def go() -> None:
            authz = self.make_port(FakeClock())
            cap = await authz.issue_capability(PRINCIPAL, READ_X)
            assert (await authz.verify(_tamper(cap), REQ_X)).ok is False
            assert (await authz.verify("not-a-token", REQ_X)).ok is False

        run(go())

    def test_denies_a_token_holding_a_lone_surrogate_instead_of_raising(self) -> None:
        async def go() -> None:
            authz = self.make_port(FakeClock())
            cap = await authz.issue_capability(PRINCIPAL, READ_X)
            payload = cap.split(".")[0]
            for bad in ("\ud800", f"{payload}.\ud800", f"\ud800{payload}.sig", f"{cap}\udfff"):
                assert (await authz.verify(bad, REQ_X)).ok is False

        run(go())

    def test_rejects_an_expired_capability(self) -> None:
        async def go() -> None:
            clock = FakeClock()
            authz = self.make_port(clock)
            cap = await authz.issue_capability(PRINCIPAL, READ_X, ttl_seconds=1)
            assert (await authz.verify(cap, REQ_X)).ok is True
            clock.advance(2)
            assert (await authz.verify(cap, REQ_X)).ok is False

        run(go())


class AuthzTenantContract:
    """Opt-in: the tenant round-trip cases (SPEC CAP-TEN-001). A port that cannot carry a tenant omits this."""

    def make_port(self, clock: FakeClock) -> AuthzPort:
        raise NotImplementedError

    def test_round_trips_the_tenant_bound_at_issuance_into_the_verify_result(self) -> None:
        async def go() -> None:
            authz = self.make_port(FakeClock())
            cap = await authz.issue_capability(PRINCIPAL, READ_X, tenant="acme")
            result = await authz.verify(cap, REQ_X)
            assert result.ok is True
            assert result.tenant == "acme"

        run(go())

    def test_reports_no_tenant_for_a_capability_issued_without_one(self) -> None:
        async def go() -> None:
            authz = self.make_port(FakeClock())
            result = await authz.verify(await authz.issue_capability(PRINCIPAL, READ_X), REQ_X)
            assert result.ok is True
            assert result.tenant is None

        run(go())

    def test_treats_an_empty_string_tenant_as_tenant_less(self) -> None:
        async def go() -> None:
            authz = self.make_port(FakeClock())
            cap = await authz.issue_capability(PRINCIPAL, READ_X, tenant="")
            result = await authz.verify(cap, REQ_X)
            assert result.ok is True
            assert result.tenant is None

        run(go())

    def test_keeps_the_tenant_out_of_reach_of_tampering(self) -> None:
        async def go() -> None:
            authz = self.make_port(FakeClock())
            cap = await authz.issue_capability(PRINCIPAL, READ_X, tenant="acme")
            assert (await authz.verify(_tamper(cap), REQ_X)).ok is False

        run(go())


class RevocableAuthzPort(AuthzPort, Protocol):
    """A concrete port that also exposes pre-expiry revocation (e.g. HmacAuthzPort)."""

    async def revoke_capability(self, token: str) -> RevokeCapabilityResult: ...


class AuthzRevocationContract:
    """Opt-in: pre-expiry revocation. ``make_port`` must really return a port with ``revoke_capability``
    (a port missing the method fails here with AttributeError rather than being skipped)."""

    def make_port(self, clock: FakeClock) -> RevocableAuthzPort:
        raise NotImplementedError

    def test_reports_not_ok_once_a_verified_capability_has_been_revoked(self) -> None:
        async def go() -> None:
            authz = self.make_port(FakeClock())
            cap = await authz.issue_capability(PRINCIPAL, READ_X)
            assert (await authz.verify(cap, REQ_X)).ok is True
            assert (await authz.revoke_capability(cap)).ok is True
            assert (await authz.verify(cap, REQ_X)).ok is False

        run(go())


ACTION = "annotate"
PAYLOAD_HASH = "sha256:" + "a" * 64
REQUESTER_ID = "contract-requester"
APPROVER_ID = "contract-approver"


class ApprovalPortContract:
    """The ApprovalPort contract: exact binding (action, payload_hash, requester, tenant), self-approval
    rejection, tamper detection, and expiry."""

    def make_port(self, clock: FakeClock) -> ApprovalPort:
        raise NotImplementedError

    async def _issue(
        self, approvals: ApprovalPort, *, tenant: str | None = None, ttl_seconds: int | None = None
    ) -> str:
        return await approvals.issue_approval(
            action=ACTION,
            payload_hash=PAYLOAD_HASH,
            requester_id=REQUESTER_ID,
            approver_id=APPROVER_ID,
            tenant=tenant,
            ttl_seconds=ttl_seconds,
        )

    async def _verify(
        self,
        approvals: ApprovalPort,
        token: str,
        *,
        action: str = ACTION,
        payload_hash: str = PAYLOAD_HASH,
        requester_id: str = REQUESTER_ID,
        tenant: str | None = None,
    ) -> bool:
        result = await approvals.verify_approval(
            token,
            action=action,
            payload_hash=payload_hash,
            requester_id=requester_id,
            tenant=tenant,
        )
        return result.ok

    def test_verifies_a_token_for_exactly_the_binding_it_was_issued_for(self) -> None:
        async def go() -> None:
            approvals = self.make_port(FakeClock())
            token = await self._issue(approvals)
            result = await approvals.verify_approval(
                token, action=ACTION, payload_hash=PAYLOAD_HASH, requester_id=REQUESTER_ID
            )
            assert result.ok is True
            assert result.grant is not None
            assert result.grant.approverId == APPROVER_ID
            assert result.grant.requesterId == REQUESTER_ID

        run(go())

    def test_rejects_issuing_a_self_approval(self) -> None:
        async def go() -> None:
            approvals = self.make_port(FakeClock())
            with pytest.raises(Exception) as info:
                await approvals.issue_approval(
                    action=ACTION,
                    payload_hash=PAYLOAD_HASH,
                    requester_id="same-person",
                    approver_id="same-person",
                )
            assert getattr(info.value, "code", None) == APPROVAL_ISSUE_ERROR_CODE

        run(go())

    def test_does_not_verify_against_a_different_action_payload_hash_requester_or_tenant(
        self,
    ) -> None:
        async def go() -> None:
            approvals = self.make_port(FakeClock())
            token = await self._issue(approvals, tenant="tenant-a")
            assert not await self._verify(approvals, token, action="delete", tenant="tenant-a")
            assert not await self._verify(
                approvals, token, payload_hash="sha256:" + "b" * 64, tenant="tenant-a"
            )
            assert not await self._verify(
                approvals, token, requester_id="someone-else", tenant="tenant-a"
            )
            assert not await self._verify(approvals, token, tenant="tenant-b")

        run(go())

    def test_rejects_a_tampered_or_malformed_token(self) -> None:
        async def go() -> None:
            approvals = self.make_port(FakeClock())
            token = await self._issue(approvals)
            assert not await self._verify(approvals, _tamper(token))
            assert not await self._verify(approvals, "not-a-token")

        run(go())

    def test_denies_a_token_holding_a_lone_surrogate_instead_of_raising(self) -> None:
        async def go() -> None:
            approvals = self.make_port(FakeClock())
            token = await self._issue(approvals)
            payload = token.split(".")[-2]
            for bad in (
                "\ud800",
                token[: token.rfind(".") + 1] + "\ud800",
                token.replace(payload, "\ud800" + payload, 1),
                token + "\udfff",
            ):
                assert not await self._verify(approvals, bad)

        run(go())

    def test_rejects_an_expired_approval(self) -> None:
        async def go() -> None:
            clock = FakeClock()
            approvals = self.make_port(clock)
            token = await self._issue(approvals, ttl_seconds=1)
            clock.advance(2)
            assert not await self._verify(approvals, token)

        run(go())


class ApprovalSingleUseContract(ApprovalPortContract):
    """Opt-in: the single-use (replay) case, for a port configured with an ApprovalStore."""

    def test_denies_a_second_verification_of_the_same_token(self) -> None:
        async def go() -> None:
            approvals = self.make_port(FakeClock())
            token = await self._issue(approvals)
            assert await self._verify(approvals, token) is True
            assert await self._verify(approvals, token) is False

        run(go())


class RevocationStoreContract:
    """The CapabilityRevocationStore contract. Asserts only what the contract specifies: inside the validity
    window ``is_revoked`` is true, and an unregistered jti is false. Expired-entry behavior is deliberately
    unspecified (a store may drop the entry or keep it), so this suite does not assert either way.

    ``make_store`` runs inside the test's event loop. A store that holds a connection overrides ``close_store`` (the
    TS suite's ``dispose``), which every case awaits, in the same loop, once it is done with the store."""

    def make_store(self) -> CapabilityRevocationStore:
        raise NotImplementedError

    async def close_store(self, store: CapabilityRevocationStore) -> None:
        return None

    def test_reports_a_jti_as_revoked_while_inside_its_validity_window(self) -> None:
        async def go() -> None:
            store = self.make_store()
            try:
                await store.revoke("contract-jti", int(time.time()) + 3600)
                assert await store.is_revoked("contract-jti") is True
            finally:
                await self.close_store(store)

        run(go())

    def test_reports_an_unregistered_jti_as_not_revoked(self) -> None:
        async def go() -> None:
            store = self.make_store()
            try:
                assert await store.is_revoked("contract-never-registered-jti") is False
            finally:
                await self.close_store(store)

        run(go())

    def test_revoking_with_an_already_past_expires_at_leaves_the_jti_unrevoked(self) -> None:
        async def go() -> None:
            store = self.make_store()
            try:
                await store.revoke("contract-jti-already-expired", int(time.time()) - 1)
                assert await store.is_revoked("contract-jti-already-expired") is False
            finally:
                await self.close_store(store)

        run(go())


__all__ = [
    "ApprovalPortContract",
    "ApprovalSingleUseContract",
    "AuthzPortContract",
    "AuthzRevocationContract",
    "AuthzTenantContract",
    "FakeClock",
    "RevocableAuthzPort",
    "RevocationStoreContract",
    "run",
]
