"""Tests for ApprovalPort (port of TS: packages/authz-hmac/test/approval-port.test.ts).

Exact binding (action / payloadHash / requester / tenant), self-approval rejection, domain separation
from capability tokens, expiry, and single-use enforcement via MemoryApprovalStore.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time

import pytest

from kohaku.spec import ApprovalVerifyResult, Principal, Scope, VerifyRequest
from sales_api.approval_port import (
    APPROVAL_TOKEN_PREFIX,
    DEFAULT_APPROVAL_TTL_SECONDS,
    HmacApprovalPort,
    MemoryApprovalStore,
    _b64url_encode,
    create_hmac_approval_port,
)
from sales_api.authz_port import create_hmac_authz_port

ACTION = "annotate"
PAYLOAD_HASH = "sha256:" + "a" * 64
REQUESTER_ID = "requester-1"
APPROVER_ID = "approver-1"


async def _issue(approvals: HmacApprovalPort, **overrides: object) -> str:
    kwargs: dict[str, object] = {
        "action": ACTION,
        "payload_hash": PAYLOAD_HASH,
        "requester_id": REQUESTER_ID,
        "approver_id": APPROVER_ID,
    }
    kwargs.update(overrides)
    return await approvals.issue_approval(**kwargs)  # type: ignore[arg-type]


async def _verify(
    approvals: HmacApprovalPort,
    token: str,
    *,
    action: str = ACTION,
    payload_hash: str = PAYLOAD_HASH,
    requester_id: str = REQUESTER_ID,
    tenant: str | None = None,
) -> ApprovalVerifyResult:
    return await approvals.verify_approval(
        token, action=action, payload_hash=payload_hash, requester_id=requester_id, tenant=tenant
    )


class TestIssuance:
    def test_issues_a_token_that_verifies_against_its_exact_binding(self) -> None:
        async def run() -> None:
            approvals = create_hmac_approval_port("test-secret")
            token = await _issue(approvals)
            result = await _verify(approvals, token)
            assert result.ok is True
            assert result.grant is not None
            assert result.grant.approverId == APPROVER_ID
            assert result.grant.requesterId == REQUESTER_ID

        asyncio.run(run())

    def test_rejects_issuing_a_self_approval(self) -> None:
        async def run() -> None:
            approvals = create_hmac_approval_port("test-secret")
            with pytest.raises(ValueError, match="approverId must differ from requesterId"):
                await _issue(approvals, requester_id="same-person", approver_id="same-person")

        asyncio.run(run())


class TestBindingChecks:
    def test_rejects_a_different_action(self) -> None:
        async def run() -> None:
            approvals = create_hmac_approval_port("test-secret")
            token = await _issue(approvals)
            result = await _verify(approvals, token, action="delete")
            assert result.ok is False
            assert result.reason == "approval is bound to a different action"

        asyncio.run(run())

    def test_rejects_a_different_payload_hash(self) -> None:
        async def run() -> None:
            approvals = create_hmac_approval_port("test-secret")
            token = await _issue(approvals)
            result = await _verify(approvals, token, payload_hash="sha256:" + "b" * 64)
            assert result.ok is False
            assert result.reason == "approval is bound to a different payload"

        asyncio.run(run())

    def test_rejects_a_different_requester(self) -> None:
        async def run() -> None:
            approvals = create_hmac_approval_port("test-secret")
            token = await _issue(approvals)
            result = await _verify(approvals, token, requester_id="someone-else")
            assert result.ok is False
            assert result.reason == "approval is bound to a different requester"

        asyncio.run(run())

    def test_rejects_a_different_tenant_and_matches_when_both_unspecified(self) -> None:
        async def run() -> None:
            approvals = create_hmac_approval_port("test-secret")
            token = await _issue(approvals, tenant="tenant-a")
            mismatched = await _verify(approvals, token, tenant="tenant-b")
            assert mismatched.ok is False
            assert mismatched.reason == "approval is bound to a different tenant"
            matched = await _verify(approvals, token, tenant="tenant-a")
            assert matched.ok is True

            no_tenant_token = await _issue(approvals)
            assert (await _verify(approvals, no_tenant_token)).ok is True

        asyncio.run(run())

    def test_treats_empty_string_tenant_as_distinct_from_unspecified_in_both_directions(self) -> None:
        # Regression: the tenant comparison used to fold "" to None via `x or None`, matching a token
        # issued for tenant="" against a verification request with no tenant at all (or vice versa). TS's
        # `claims.tenant ?? undefined` only normalizes null/undefined, never a falsy-but-present empty
        # string, so this pins the same behavior here.
        async def run() -> None:
            approvals = create_hmac_approval_port("test-secret")

            empty_tenant_token = await _issue(approvals, tenant="")
            empty_vs_unset = await _verify(approvals, empty_tenant_token)
            assert empty_vs_unset.ok is False
            assert empty_vs_unset.reason == "approval is bound to a different tenant"

            no_tenant_token = await _issue(approvals)
            unset_vs_empty = await _verify(approvals, no_tenant_token, tenant="")
            assert unset_vs_empty.ok is False
            assert unset_vs_empty.reason == "approval is bound to a different tenant"

            # tenant="" on both sides still matches (it is a real, if unusual, tenant value).
            both_empty = await _verify(approvals, empty_tenant_token, tenant="")
            assert both_empty.ok is True

        asyncio.run(run())


class TestExpiry:
    def test_rejects_an_expired_approval(self) -> None:
        async def run() -> None:
            clock = {"t": 1_000_000.0}
            approvals = create_hmac_approval_port("test-secret", ttl_seconds=1, now=lambda: clock["t"])
            token = await _issue(approvals)
            assert (await _verify(approvals, token)).ok is True
            clock["t"] += 1  # exp <= now boundary
            result = await _verify(approvals, token)
            assert result.ok is False
            assert result.reason == "approval expired"

        asyncio.run(run())

    def test_default_ttl_matches_default_approval_ttl_seconds(self) -> None:
        async def run() -> None:
            clock = {"t": 1_000_000.0}
            approvals = create_hmac_approval_port("test-secret", now=lambda: clock["t"])
            token = await _issue(approvals)
            clock["t"] += DEFAULT_APPROVAL_TTL_SECONDS - 1
            assert (await _verify(approvals, token)).ok is True
            clock["t"] += 1
            assert (await _verify(approvals, token)).ok is False

        asyncio.run(run())


class TestDomainSeparation:
    def test_rejects_a_capability_token_presented_as_an_approval(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            approvals = create_hmac_approval_port("test-secret")
            cap = await authz.issue_capability(Principal(id="u"), [Scope(kind="write", ref="annotate")])
            result = await _verify(approvals, cap)
            assert result.ok is False

        asyncio.run(run())

    def test_rejects_an_approval_token_presented_as_a_capability(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            approvals = create_hmac_approval_port("test-secret")
            token = await _issue(approvals)
            result = await authz.verify(token, VerifyRequest(kind="write", ref="annotate"))
            assert result.ok is False

        asyncio.run(run())


    def test_rejects_an_approval_token_with_its_prefix_stripped(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            token = await _issue(create_hmac_approval_port("test-secret"))
            stripped = token[len(APPROVAL_TOKEN_PREFIX) :]
            result = await authz.verify(stripped, VerifyRequest(kind="write", ref="annotate"))
            assert result.ok is False
            assert result.reason == "invalid signature"

        asyncio.run(run())

    def test_rejects_a_capability_token_with_the_approval_prefix_prepended(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            approvals = create_hmac_approval_port("test-secret")
            cap = await authz.issue_capability(Principal(id="u"), [Scope(kind="write", ref="annotate")])
            result = await _verify(approvals, APPROVAL_TOKEN_PREFIX + cap)
            assert (result.ok, result.reason) == (False, "invalid signature")

        asyncio.run(run())

    def test_rejects_a_v1_token(self) -> None:
        async def run() -> None:
            claims = {
                "action": ACTION,
                "payloadHash": PAYLOAD_HASH,
                "approverId": APPROVER_ID,
                "requesterId": REQUESTER_ID,
                "exp": int(time.time()) + 300,
                "jti": "jti-v1",
            }
            payload = _b64url_encode(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
            sig = _b64url_encode(hmac.new(b"test-secret", payload.encode("utf-8"), hashlib.sha256).digest())
            result = await _verify(create_hmac_approval_port("test-secret"), f"kohaku-approval.v1.{payload}.{sig}")
            assert (result.ok, result.reason) == (False, "not an approval token")

        asyncio.run(run())


def _forge(secret: str, claims: object) -> str:
    """A correctly signed v2 token carrying arbitrary claims (what a holder of the shared secret could mint)."""
    key = hmac.new(secret.encode("utf-8"), b"kohaku-approval-v2", hashlib.sha256).digest()
    payload = _b64url_encode(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
    sig = _b64url_encode(hmac.new(key, (APPROVAL_TOKEN_PREFIX + payload).encode("utf-8"), hashlib.sha256).digest())
    return f"{APPROVAL_TOKEN_PREFIX}{payload}.{sig}"


class TestMalformedTokens:
    def test_non_ascii_tampered_signature_is_denied_not_raised(self) -> None:
        async def run() -> None:
            approvals = create_hmac_approval_port("test-secret")
            token = await _issue(approvals)
            tampered = token[: token.rfind(".") + 1] + "sig\u00e9\u3042"
            result = await _verify(approvals, tampered)
            assert (result.ok, result.reason) == (False, "invalid signature")

        asyncio.run(run())

    @pytest.mark.parametrize(
        "mutation",
        [
            {"action": 7},
            {"payloadHash": None},
            {"requesterId": {}},
            {"approverId": ["a"]},
            {"exp": "9999999999"},
            {"exp": True},
            {"jti": None},
            {"tenant": 5},
        ],
    )
    def test_a_correctly_signed_but_malformed_claim_is_denied(self, mutation: dict[str, object]) -> None:
        async def run() -> None:
            claims: dict[str, object] = {
                "action": ACTION,
                "payloadHash": PAYLOAD_HASH,
                "approverId": APPROVER_ID,
                "requesterId": REQUESTER_ID,
                "exp": int(time.time()) + 300,
                "jti": "j",
            }
            claims.update(mutation)
            result = await _verify(create_hmac_approval_port("test-secret"), _forge("test-secret", claims))
            assert (result.ok, result.reason) == (False, "malformed payload")

        asyncio.run(run())

    def test_a_non_object_payload_is_denied(self) -> None:
        async def run() -> None:
            result = await _verify(create_hmac_approval_port("test-secret"), _forge("test-secret", None))
            assert (result.ok, result.reason) == (False, "malformed payload")

        asyncio.run(run())


class TestSingleUseEnforcement:
    def test_without_a_store_a_token_can_be_verified_more_than_once(self) -> None:
        async def run() -> None:
            approvals = create_hmac_approval_port("test-secret")
            token = await _issue(approvals)
            assert (await _verify(approvals, token)).ok is True
            assert (await _verify(approvals, token)).ok is True

        asyncio.run(run())

    def test_with_a_store_a_second_verification_is_denied(self) -> None:
        async def run() -> None:
            store = MemoryApprovalStore()
            approvals = create_hmac_approval_port("test-secret", store=store)
            token = await _issue(approvals)
            assert (await _verify(approvals, token)).ok is True
            second = await _verify(approvals, token)
            assert second.ok is False
            assert second.reason == "approval already used"

        asyncio.run(run())

    def test_a_binding_failure_never_consumes_the_store(self) -> None:
        async def run() -> None:
            calls: list[str] = []

            class RecordingStore:
                async def consume(self, jti: str, expires_at: int) -> bool:
                    calls.append(jti)
                    return True

            approvals = create_hmac_approval_port("test-secret", store=RecordingStore())
            token = await _issue(approvals)
            result = await _verify(approvals, token, action="delete")
            assert result.ok is False
            assert calls == []

        asyncio.run(run())

    def test_a_store_failure_propagates_as_a_raised_exception(self) -> None:
        async def run() -> None:
            class FailingStore:
                async def consume(self, jti: str, expires_at: int) -> bool:
                    raise RuntimeError("approval store unavailable (test)")

            approvals = create_hmac_approval_port("test-secret", store=FailingStore())
            token = await _issue(approvals)
            with pytest.raises(RuntimeError, match="approval store unavailable"):
                await _verify(approvals, token)

        asyncio.run(run())


class TestMemoryApprovalStore:
    def test_consume_returns_true_then_false_for_the_same_jti(self) -> None:
        async def run() -> None:
            store = MemoryApprovalStore(now=lambda: 1_000_000.0)
            assert await store.consume("jti-1", 1_000_060) is True
            assert await store.consume("jti-1", 1_000_060) is False

        asyncio.run(run())

    def test_sweeps_expired_entries(self) -> None:
        async def run() -> None:
            clock = {"t": 1000.0}
            store = MemoryApprovalStore(now=lambda: clock["t"])
            assert await store.consume("jti-1", 1010) is True
            clock["t"] = 1011  # jti-1 has now expired
            assert await store.consume("jti-2", 1100) is True

        asyncio.run(run())
