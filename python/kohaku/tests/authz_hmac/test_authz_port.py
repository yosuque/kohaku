"""Tests for the HMAC AuthzPort (port of TS: packages/authz-hmac/test/authz-port.test.ts, plus the HMAC
round-trip, expiry and wire-format cases of apps/sample-api/test/authz-port.test.ts).

Scope matching is exact (a prefix match would let ?region=us permit ?region=usa, and annotate permit annotateAll).
Tokens are wire-compatible with TS (base64url(payload).base64url(hmac), payload = {sub, scopes, exp, jti, tenant?}).
The byte-level cross-language golden lives in tests/spec/test_cross_language_golden.py (``authzHmac``).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json

import pytest

from kohaku.authz_hmac import create_hmac_authz_port
from kohaku.authz_hmac.authz_port import b64url_encode as b64url
from kohaku.spec import Principal, Scope, VerifyRequest

PRINCIPAL = Principal(id="u", roles=["user"])


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class TestScopeExactMatch:
    def test_read_scope_does_not_cross_value_boundary(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            cap = await authz.issue_capability(
                PRINCIPAL, [Scope(kind="read", ref="query://sales/summary?region=us")]
            )
            ok = await authz.verify(
                cap, VerifyRequest(kind="read", ref="query://sales/summary?region=us")
            )
            assert ok.ok is True
            ng = await authz.verify(
                cap, VerifyRequest(kind="read", ref="query://sales/summary?region=usa")
            )
            assert ng.ok is False

        asyncio.run(run())

    def test_write_scope_does_not_prefix_match(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            cap = await authz.issue_capability(PRINCIPAL, [Scope(kind="write", ref="annotate")])
            assert (await authz.verify(cap, VerifyRequest(kind="write", ref="annotate"))).ok is True
            assert (
                await authz.verify(cap, VerifyRequest(kind="write", ref="annotateAll"))
            ).ok is False

        asyncio.run(run())


class TestRoundtripAndWire:
    def test_roundtrip_returns_principal(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            cap = await authz.issue_capability(
                PRINCIPAL, [Scope(kind="read", ref="query://sales/kpi?fy=2026")]
            )
            result = await authz.verify(
                cap, VerifyRequest(kind="read", ref="query://sales/kpi?fy=2026")
            )
            assert result.ok is True
            assert result.principal is not None and result.principal.id == "u"

        asyncio.run(run())

    def test_wire_format_payload_structure(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            cap = await authz.issue_capability(
                PRINCIPAL, [Scope(kind="write", ref="annotate")], ttl_seconds=600
            )
            parts = cap.split(".")
            assert len(parts) == 2  # payload.signature
            payload = json.loads(_b64url_decode(parts[0]).decode("utf-8"))
            assert list(payload.keys()) == ["sub", "scopes", "exp", "jti"]
            assert isinstance(payload["jti"], str) and payload["jti"] != ""
            assert payload["sub"] == "u"
            assert payload["scopes"] == [{"kind": "write", "ref": "annotate"}]
            assert isinstance(payload["exp"], int)

        asyncio.run(run())

    def test_cross_verifies_secret_dependent(self) -> None:
        """A token issued with a different secret fails verification (signature-dependent)."""

        async def run() -> None:
            issuer = create_hmac_authz_port("secret-a")
            verifier = create_hmac_authz_port("secret-b")
            cap = await issuer.issue_capability(
                PRINCIPAL, [Scope(kind="read", ref="query://sales/summary")]
            )
            result = await verifier.verify(
                cap, VerifyRequest(kind="read", ref="query://sales/summary")
            )
            assert result.ok is False
            assert result.reason == "invalid signature"

        asyncio.run(run())


class TestExpiryAndMalformed:
    def test_expired_capability(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            cap = await authz.issue_capability(
                PRINCIPAL, [Scope(kind="read", ref="query://sales/kpi")], ttl_seconds=-10
            )
            result = await authz.verify(cap, VerifyRequest(kind="read", ref="query://sales/kpi"))
            assert result.ok is False
            assert result.reason == "capability expired"

        asyncio.run(run())

    def test_token_expires_exactly_at_its_exp_instant(self) -> None:
        """TS isExpired is `exp <= now`: a token is expired at the boundary second, not only after it."""

        async def run() -> None:
            clock = {"t": 1000.0}
            authz = create_hmac_authz_port("test-secret", now=lambda: clock["t"])
            cap = await authz.issue_capability(
                PRINCIPAL, [Scope(kind="read", ref="query://sales/kpi")], ttl_seconds=10
            )
            req = VerifyRequest(kind="read", ref="query://sales/kpi")

            clock["t"] = 1009.0  # exp - 1: still valid
            assert (await authz.verify(cap, req)).ok is True

            clock["t"] = 1010.5  # the same second as exp (the clock is floored): expired
            at_boundary = await authz.verify(cap, req)
            assert at_boundary.ok is False
            assert at_boundary.reason == "capability expired"

            clock["t"] = 1011.0
            assert (await authz.verify(cap, req)).ok is False

        asyncio.run(run())

    def test_malformed_token(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            result = await authz.verify(
                "no-dot-here", VerifyRequest(kind="read", ref="query://sales/kpi")
            )
            assert result.ok is False
            assert result.reason == "malformed token"

        asyncio.run(run())

    def test_tampered_signature(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            cap = await authz.issue_capability(
                PRINCIPAL, [Scope(kind="read", ref="query://sales/kpi")]
            )
            payload = cap.split(".")[0]
            result = await authz.verify(
                f"{payload}.tampered", VerifyRequest(kind="read", ref="query://sales/kpi")
            )
            assert result.ok is False
            assert result.reason == "invalid signature"

        asyncio.run(run())

    def test_non_ascii_signature_is_denied_not_raised(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            cap = await authz.issue_capability(
                PRINCIPAL, [Scope(kind="read", ref="query://sales/kpi")]
            )
            payload = cap.split(".")[0]
            result = await authz.verify(
                f"{payload}.sig\u00e9\u3042", VerifyRequest(kind="read", ref="query://sales/kpi")
            )
            assert result.ok is False
            assert result.reason == "invalid signature"

        asyncio.run(run())

    def test_signed_payload_with_malformed_claims_is_denied(self) -> None:
        async def run() -> None:
            secret = "test-secret"
            for claims in (
                {"sub": "u", "scopes": "read", "exp": 9999999999},
                {"sub": 1, "scopes": [], "exp": 9999999999},
                {"sub": "u", "exp": 9999999999},
            ):
                payload = (
                    base64.urlsafe_b64encode(json.dumps(claims).encode("utf-8"))
                    .rstrip(b"=")
                    .decode("ascii")
                )
                digest = hmac.new(
                    secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
                ).digest()
                sig = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
                result = await create_hmac_authz_port(secret).verify(
                    f"{payload}.{sig}", VerifyRequest(kind="read", ref="query://sales/kpi")
                )
                assert (result.ok, result.reason) == (False, "malformed payload")

        asyncio.run(run())


# A token in the TS authz-hmac wire shape (`{sub, scopes, exp, jti, tenant}`, HMAC-SHA256 over the payload
# string), built with Node for secret "interop-secret"; the identical literal is verified by the TS test
# packages/authz-hmac/test/authz-port.test.ts ("TS-issued wire token").
_TS_TENANT_TOKEN = (
    "eyJzdWIiOiJpbnRlcm9wLXVzZXIiLCJzY29wZXMiOlt7ImtpbmQiOiJyZWFkIiwicmVmIjoicXVlcnk6Ly9zYWxlcy9zdW1tYXJ5"
    "P2Z5PTIwMjYifV0sImV4cCI6NDEwMjQ0NDgwMCwianRpIjoiaW50ZXJvcC1qdGkiLCJ0ZW5hbnQiOiJhY21lIn0"
    ".pT4L2fW_JAjOiuJ-e6S_kuhepszrDrl7fJZwHhY6hj4"
)
_TS_REQ = VerifyRequest(kind="read", ref="query://sales/summary?fy=2026")


class TestTenantClaim:
    """SPEC CAP-TEN-001: the capability carries an optional signed tenant (port of the TS authz-hmac tests)."""

    def test_issue_signs_tenant_and_verify_returns_it(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            cap = await authz.issue_capability(
                PRINCIPAL, [Scope(kind="read", ref="query://s/x")], tenant="acme"
            )
            payload = json.loads(_b64url_decode(cap.split(".")[0]).decode("utf-8"))
            assert list(payload.keys()) == ["sub", "scopes", "exp", "jti", "tenant"]
            result = await authz.verify(cap, VerifyRequest(kind="read", ref="query://s/x"))
            assert result.ok is True
            assert result.tenant == "acme"
            assert result.principal is not None and result.principal.id == "u"

        asyncio.run(run())

    def test_empty_tenant_is_never_signed(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            cap = await authz.issue_capability(
                PRINCIPAL, [Scope(kind="read", ref="query://s/x")], tenant=""
            )
            payload = json.loads(_b64url_decode(cap.split(".")[0]).decode("utf-8"))
            assert "tenant" not in payload
            result = await authz.verify(cap, VerifyRequest(kind="read", ref="query://s/x"))
            assert result.ok is True and result.tenant is None

        asyncio.run(run())

    def test_tenant_less_token_verifies_with_no_tenant_by_default(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            cap = await authz.issue_capability(PRINCIPAL, [Scope(kind="read", ref="query://s/x")])
            result = await authz.verify(cap, VerifyRequest(kind="read", ref="query://s/x"))
            assert result.ok is True and result.tenant is None

        asyncio.run(run())

    def test_require_tenant_rejects_a_tenant_less_token_and_accepts_a_bound_one(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret", require_tenant=True)
            req = VerifyRequest(kind="read", ref="query://s/x")
            without = await authz.issue_capability(
                PRINCIPAL, [Scope(kind="read", ref="query://s/x")]
            )
            denied = await authz.verify(without, req)
            assert denied.ok is False and denied.reason == "capability lacks tenant"
            bound = await authz.issue_capability(
                PRINCIPAL, [Scope(kind="read", ref="query://s/x")], tenant="acme"
            )
            assert (await authz.verify(bound, req)).ok is True

        asyncio.run(run())

    def test_editing_the_tenant_invalidates_the_signature(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            cap = await authz.issue_capability(
                PRINCIPAL, [Scope(kind="read", ref="query://s/x")], tenant="acme"
            )
            payload_b64, signature = cap.split(".")
            claims = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
            claims["tenant"] = "evil"
            forged = (
                base64.urlsafe_b64encode(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
                .rstrip(b"=")
                .decode("ascii")
            )
            result = await authz.verify(
                f"{forged}.{signature}", VerifyRequest(kind="read", ref="query://s/x")
            )
            assert result.ok is False and result.reason == "invalid signature"

        asyncio.run(run())

    def test_verifies_a_ts_issued_wire_token_and_reads_its_tenant(self) -> None:
        """TS ↔ Python interop: the TS token (with its extra `jti` claim) verifies and yields the tenant."""

        async def run() -> None:
            authz = create_hmac_authz_port("interop-secret")
            result = await authz.verify(_TS_TENANT_TOKEN, _TS_REQ)
            assert result.ok is True
            assert result.tenant == "acme"
            assert result.principal is not None and result.principal.id == "interop-user"
            strict = create_hmac_authz_port("interop-secret", require_tenant=True)
            assert (await strict.verify(_TS_TENANT_TOKEN, _TS_REQ)).ok is True

        asyncio.run(run())


def _signed_with(secret: str, **claims: object) -> str:
    base: dict[str, object] = {
        "sub": "u",
        "scopes": [{"kind": "read", "ref": "query://s/x"}],
        "exp": 4102444800,
    }
    base.update(claims)
    payload = (
        base64.urlsafe_b64encode(json.dumps(base, separators=(",", ":")).encode("utf-8"))
        .rstrip(b"=")
        .decode("ascii")
    )
    digest = hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).digest()
    return f"{payload}.{base64.urlsafe_b64encode(digest).rstrip(b'=').decode('ascii')}"


class TestTenantClaimValidationAndInterop:
    def test_an_explicit_null_tenant_claim_is_malformed(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("s")
            req = VerifyRequest(kind="read", ref="query://s/x")
            denied = await authz.verify(_signed_with("s", tenant=None), req)
            assert denied.ok is False and denied.reason == "malformed payload"
            assert (await authz.verify(_signed_with("s"), req)).ok is True

        asyncio.run(run())

    def test_over_long_or_control_character_tenants_are_rejected_on_verify_and_issue(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("s")
            req = VerifyRequest(kind="read", ref="query://s/x")
            assert (await authz.verify(_signed_with("s", tenant="a" * 256), req)).ok is True
            for tenant in ("a" * 257, "ac\nme", "ac\x00me", "ac\x7fme"):
                denied = await authz.verify(_signed_with("s", tenant=tenant), req)
                assert denied.ok is False and denied.reason == "malformed payload"
                with pytest.raises(ValueError, match="tenant"):
                    await authz.issue_capability(PRINCIPAL, [], tenant=tenant)

        asyncio.run(run())


class TestTtlOption:
    """TS: createHmacAuthzPort options.ttlSeconds."""

    def test_uses_ttl_seconds_as_the_default_and_lets_issue_capability_override_it(self) -> None:
        async def run() -> None:
            clock = {"t": 1_000_000.0}
            authz = create_hmac_authz_port("test-secret", ttl_seconds=2, now=lambda: clock["t"])
            scopes = [Scope(kind="read", ref="query://s/x")]
            short = await authz.issue_capability(PRINCIPAL, scopes)
            long = await authz.issue_capability(PRINCIPAL, scopes, ttl_seconds=10)
            clock["t"] = 1_000_003.0
            req = VerifyRequest(kind="read", ref="query://s/x")
            assert (await authz.verify(short, req)).ok is False
            assert (await authz.verify(long, req)).ok is True

        asyncio.run(run())

    def test_default_ttl_is_the_shared_spec_default(self) -> None:
        """TS capability-ttl.test.ts: authz-hmac's DEFAULT_CAPABILITY_TTL_SECONDS is spec-core's, not a local copy."""
        from kohaku.authz_hmac import DEFAULT_CAPABILITY_TTL_SECONDS as FROM_AUTHZ_HMAC
        from kohaku.host_core import DEFAULT_CAPABILITY_TTL_SECONDS as FROM_HOST_CORE
        from kohaku.spec import DEFAULT_CAPABILITY_TTL_SECONDS as FROM_SPEC

        assert FROM_AUTHZ_HMAC == FROM_SPEC == FROM_HOST_CORE == 600

        async def run() -> None:
            authz = create_hmac_authz_port("test-secret", now=lambda: 1000.0)
            cap = await authz.issue_capability(PRINCIPAL, [])
            payload = json.loads(_b64url_decode(cap.split(".")[0]).decode("utf-8"))
            assert payload["exp"] == 1000 + FROM_SPEC

        asyncio.run(run())


class TestRequireJti:
    """TS: createHmacAuthzPort options.requireJti."""

    REQ = VerifyRequest(kind="read", ref="query://s/x")

    def test_default_a_jti_less_token_still_verifies(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            assert (await authz.verify(_signed_with("test-secret"), self.REQ)).ok is True

        asyncio.run(run())

    def test_true_rejects_a_jti_less_token(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret", require_jti=True)
            result = await authz.verify(_signed_with("test-secret"), self.REQ)
            assert (result.ok, result.reason) == (False, "capability lacks jti")

        asyncio.run(run())

    def test_true_a_token_that_carries_a_jti_still_verifies(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret", require_jti=True)
            cap = await authz.issue_capability(PRINCIPAL, [Scope(kind="read", ref="query://s/x")])
            assert (await authz.verify(cap, self.REQ)).ok is True

        asyncio.run(run())


class _RecordingStore:
    def __init__(self, *, fail: bool = False) -> None:
        self.calls: list[str] = []
        self._fail = fail

    async def revoke(self, jti: str, expires_at: int) -> None:
        self.calls.append(f"revoke:{jti}")

    async def is_revoked(self, jti: str) -> bool:
        self.calls.append(f"is_revoked:{jti}")
        if self._fail:
            raise RuntimeError("store unavailable (test)")
        return False


class TestScopeEvaluatedBeforeRevocationStore:
    """TS: verify: scope evaluated before the revocation store."""

    def test_an_out_of_scope_request_never_calls_is_revoked(self) -> None:
        async def run() -> None:
            store = _RecordingStore()
            authz = create_hmac_authz_port("test-secret", revocation=store)
            cap = await authz.issue_capability(PRINCIPAL, [Scope(kind="read", ref="query://s/x")])
            result = await authz.verify(cap, VerifyRequest(kind="read", ref="query://s/y"))
            assert result.ok is False
            assert store.calls == []

        asyncio.run(run())

    def test_a_revocation_store_failure_propagates_fail_closed_for_an_in_scope_request(
        self,
    ) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret", revocation=_RecordingStore(fail=True))
            cap = await authz.issue_capability(PRINCIPAL, [Scope(kind="read", ref="query://s/x")])
            with pytest.raises(RuntimeError, match="store unavailable"):
                await authz.verify(cap, VerifyRequest(kind="read", ref="query://s/x"))

        asyncio.run(run())

    def test_a_jti_less_token_never_consults_the_store(self) -> None:
        async def run() -> None:
            store = _RecordingStore()
            authz = create_hmac_authz_port("test-secret", revocation=store)
            result = await authz.verify(
                _signed_with("test-secret"), VerifyRequest(kind="read", ref="query://s/x")
            )
            assert result.ok is True
            assert store.calls == []

        asyncio.run(run())


class TestPreUpgradeTokenAndMalformedClaims:
    def test_a_tenant_less_jti_less_pre_upgrade_token_verifies_with_no_tenant(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            result = await authz.verify(
                _signed_with("test-secret"), VerifyRequest(kind="read", ref="query://s/x")
            )
            assert (result.ok, result.tenant) == (True, None)
            assert result.principal is not None and result.principal.id == "u"

        asyncio.run(run())

    @pytest.mark.parametrize(
        "claims",
        [
            None,
            [],
            {"sub": "u", "scopes": "write", "exp": 9999999999},
            {"sub": "u", "exp": 9999999999},
            {"sub": "u", "scopes": [None], "exp": 9999999999},
            {"sub": "u", "scopes": [{"kind": "write"}], "exp": 9999999999},
            {"sub": "u", "scopes": [], "exp": "9999999999"},
            {"sub": "u", "scopes": [], "exp": True},
            {"sub": 1, "scopes": [], "exp": 9999999999},
            {"sub": "u", "scopes": [], "exp": 9999999999, "jti": 1},
            {"sub": "u", "scopes": [], "exp": 9999999999, "jti": None},
        ],
    )
    def test_a_correctly_signed_malformed_claim_set_is_denied_never_raised(
        self, claims: object
    ) -> None:
        """TS approval-port.test.ts "capability: %s -> denied as malformed": verify AND revoke both deny."""

        async def run() -> None:
            secret = "test-secret"
            payload = b64url(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
            digest = hmac.new(
                secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
            ).digest()
            token = f"{payload}.{b64url(digest)}"
            authz = create_hmac_authz_port(secret)
            verified = await authz.verify(token, VerifyRequest(kind="write", ref="annotate"))
            assert (verified.ok, verified.reason) == (False, "malformed payload")
            revoked = await authz.revoke_capability(token)
            assert (revoked.ok, revoked.code) == (False, "MALFORMED")

        asyncio.run(run())

    def test_a_non_finite_exp_is_malformed_not_immortal(self) -> None:
        """json.loads accepts NaN / Infinity; `NaN <= now` is False, so without the finiteness check a NaN exp
        would never expire (TS: Number.isFinite)."""

        async def run() -> None:
            secret = "test-secret"
            payload = b64url(b'{"sub":"u","scopes":[],"exp":NaN}')
            digest = hmac.new(
                secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
            ).digest()
            result = await create_hmac_authz_port(secret).verify(
                f"{payload}.{b64url(digest)}", VerifyRequest(kind="read", ref="query://s/x")
            )
            assert (result.ok, result.reason) == (False, "malformed payload")

        asyncio.run(run())


class TestTenantLengthInUtf16CodeUnits:
    """TS counts `String.length` (UTF-16 code units): an astral-plane character is 2 units."""

    def test_an_astral_tenant_near_the_limit_is_counted_in_code_units(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("s")
            req = VerifyRequest(kind="read", ref="query://s/x")
            ok = "\U0001f600" * 128  # 128 characters = 256 code units: accepted
            too_long = "\U0001f600" * 129  # 129 characters = 258 code units: rejected (like TS)
            assert (await authz.verify(_signed_with("s", tenant=ok), req)).tenant == ok
            denied = await authz.verify(_signed_with("s", tenant=too_long), req)
            assert (denied.ok, denied.reason) == (False, "malformed payload")
            await authz.issue_capability(PRINCIPAL, [], tenant=ok)
            with pytest.raises(ValueError, match="tenant"):
                await authz.issue_capability(PRINCIPAL, [], tenant=too_long)

        asyncio.run(run())


class TestHugeIntegerExp:
    def test_an_integer_exp_too_large_for_a_float_is_malformed_not_an_exception(self) -> None:
        async def run() -> None:
            secret = "test-secret"
            payload = b64url(b'{"sub":"u","scopes":[],"exp":1' + b"0" * 400 + b"}")
            digest = hmac.new(
                secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
            ).digest()
            result = await create_hmac_authz_port(secret).verify(
                f"{payload}.{b64url(digest)}", VerifyRequest(kind="read", ref="query://s/x")
            )
            assert (result.ok, result.reason) == (False, "malformed payload")

        asyncio.run(run())
