"""Port of TS packages/authz-jwt/test/authz-port.test.ts. The TS contract registration
(``describeAuthzPortContract(..., { revocation: true, tenant: true })``) maps to the three opt-in contract
classes of ``tests/authz_hmac/_contract.py``, which are reused as they are."""

from __future__ import annotations

import inspect

import pytest

from kohaku.authz_hmac import create_hmac_authz_port
from kohaku.authz_jwt import JwtAuthzPort, JwtIdentityError, JwtSecretKey, create_jwt_authz_port
from kohaku.host_core import authz_accepts_tenant
from kohaku.spec import (
    DEFAULT_CAPABILITY_TTL_SECONDS,
    Principal,
    Scope,
    VerifyRequest,
    VerifyResult,
)

from ..authz_hmac._contract import (
    AuthzPortContract,
    AuthzRevocationContract,
    AuthzTenantContract,
    FakeClock,
)
from ._tokens import SECRET, hs256, run

READ_X = [Scope(kind="read", ref="query://sales/x")]
REQ_X = VerifyRequest(kind="read", ref="query://sales/x")


def _port(**kwargs: object) -> JwtAuthzPort:
    return create_jwt_authz_port(JwtSecretKey(SECRET), capability_secret="cap-secret", **kwargs)  # type: ignore[arg-type]


class TestCreateJwtAuthzPort:
    def test_issues_and_verifies_hmac_capabilities_exactly_like_authz_hmac(self) -> None:
        port = _port(capability_ttl_seconds=60)
        token = run(port.issue_capability(Principal(id="u1"), READ_X))
        result = run(port.verify(token, REQ_X))
        assert result.ok is True
        assert result.principal is not None and result.principal.id == "u1"
        assert run(port.verify(token, VerifyRequest(kind="write", ref="annotate"))).ok is False

        # "exactly like": the token is an authz-hmac token, so a bare HMAC port with the same secret accepts it.
        assert run(create_hmac_authz_port("cap-secret").verify(token, REQ_X)).ok is True

    def test_exposes_the_identity_resolver_used_to_turn_a_bearer_jwt_into_a_principal(self) -> None:
        token = hs256({"sub": "u9", "roles": ["admin"]})
        resolved = run(_port().identity.from_authorization_header(f"Bearer {token}"))
        assert resolved.principal.roles == ["admin"]

    def test_a_jwt_is_never_a_capability_and_a_capability_is_never_a_jwt(self) -> None:
        port = _port()
        bearer = hs256({"sub": "u"})
        assert run(port.verify(bearer, REQ_X)).ok is False
        capability = run(port.issue_capability(Principal(id="u"), READ_X))
        # Signed with the *capability* secret, not the JWT one: the identity resolver refuses it.
        with pytest.raises(JwtIdentityError) as info:
            run(port.identity.resolve(capability))
        assert info.value.code == "INVALID_TOKEN"


class TestCapabilityTenant:
    """Capability tenant, delegated to authz-hmac."""

    def test_round_trips_the_tenant_through_issue_and_verify(self) -> None:
        port = _port()
        token = run(port.issue_capability(Principal(id="u1"), READ_X, tenant="acme"))
        result = run(port.verify(token, REQ_X))
        assert result.ok is True and result.tenant == "acme"

    def test_require_capability_tenant_rejects_a_tenant_less_capability_independent_of_require_tenant(
        self,
    ) -> None:
        port = _port(require_capability_tenant=True)
        without = run(port.issue_capability(Principal(id="u1"), READ_X))
        assert run(port.verify(without, REQ_X)) == VerifyResult(
            ok=False, reason="capability lacks tenant"
        )
        with_tenant = run(port.issue_capability(Principal(id="u1"), READ_X, tenant="acme"))
        assert run(port.verify(with_tenant, REQ_X)).ok is True

        lenient = _port()
        assert run(
            lenient.verify(run(lenient.issue_capability(Principal(id="u1"), READ_X)), REQ_X)
        ).ok

    def test_require_tenant_governs_the_jwt_claim_not_the_capability(self) -> None:
        # The inherited `require_tenant` (the bearer JWT's own tenant claim) leaves capabilities lenient.
        port = _port(require_tenant=True)
        assert run(port.verify(run(port.issue_capability(Principal(id="u1"), READ_X)), REQ_X)).ok

    def test_issue_capability_accepts_the_tenant_keyword_the_rest_host_probes_for(self) -> None:
        # host_core.authz_accepts_tenant decides by signature: a port that lost the keyword would silently issue
        # tenant-less capabilities (SPEC CAP-TEN-001).
        assert "tenant" in inspect.signature(_port().issue_capability).parameters
        assert authz_accepts_tenant(_port()) is True


class TestDefaultCapabilityTtl:
    def test_issues_capabilities_with_the_default_ttl_when_capability_ttl_seconds_is_omitted(
        self,
    ) -> None:
        clock = FakeClock()
        port = _port(now=clock)
        token = run(port.issue_capability(Principal(id="u1"), READ_X))

        clock.advance(DEFAULT_CAPABILITY_TTL_SECONDS - 1)
        assert run(port.verify(token, REQ_X)).ok is True

        clock.advance(2)
        assert run(port.verify(token, REQ_X)).ok is False


class TestCapabilityRevocation:
    def test_verifies_ok_then_reports_revoked_once_revoke_capability_has_been_called(self) -> None:
        port = _port()
        cap = run(port.issue_capability(Principal(id="u1"), READ_X))
        assert run(port.verify(cap, REQ_X)).ok is True

        revoked = run(port.revoke_capability(cap))
        assert revoked.ok is True and revoked.code is None

        assert run(port.verify(cap, REQ_X)) == VerifyResult(ok=False, reason="capability revoked")

    def test_a_revocation_store_passed_in_is_the_one_consulted(self) -> None:
        from kohaku.authz_hmac import create_memory_revocation_store

        store = create_memory_revocation_store()
        a, b = _port(revocation=store), _port(revocation=store)
        cap = run(a.issue_capability(Principal(id="u1"), READ_X))
        run(a.revoke_capability(cap))
        # A second port sharing the store (a multi-instance deployment) sees the revocation too.
        assert run(b.verify(cap, REQ_X)).reason == "capability revoked"


class TestJwtPortContract(AuthzPortContract, AuthzTenantContract, AuthzRevocationContract):
    """TS: describeAuthzPortContract("jwt (capabilities via authz-hmac)", ..., { revocation, tenant })."""

    def make_port(self, clock: FakeClock) -> JwtAuthzPort:
        return _port(now=clock)
