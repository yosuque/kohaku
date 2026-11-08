"""AuthzPort for JWT / OIDC deployments (port of packages/authz-jwt/src/authz-port.ts).

The two halves of the contract are deliberately separate: capability tokens (issue / verify / revoke) are the
existing HMAC scheme from `kohaku.authz_hmac`, unchanged; the identity resolver only turns the caller's bearer JWT
into a Principal + tenant for the host's own hooks. A capability is never a JWT and a JWT is never a capability.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from typing import Any

from kohaku.authz_hmac import HmacAuthzPort, create_hmac_authz_port
from kohaku.spec import (
    CapabilityRevocationStore,
    Principal,
    RevokeCapabilityResult,
    Scope,
    VerifyRequest,
    VerifyResult,
)

from .identity import (
    JwtClaimNames,
    JwtIdentityResolver,
    JwtKeySource,
    ResolvedIdentity,
    create_jwt_identity_resolver,
)


class JwtAuthzPort:
    """An AuthzPort whose capabilities are HMAC tokens and whose ``identity`` resolves bearer JWTs. Build one with
    `create_jwt_authz_port`."""

    def __init__(self, identity: JwtIdentityResolver, capabilities: HmacAuthzPort) -> None:
        self.identity: JwtIdentityResolver = identity
        """The resolver a host wires into its principal/tenant hooks (host_rest ``auth`` / ``tenant``, MCP
        ``resolve_principal``)."""
        self._capabilities = capabilities

    async def issue_capability(
        self,
        principal: Principal,
        scopes: list[Scope],
        *,
        ttl_seconds: int | None = None,
        tenant: str | None = None,
    ) -> str:
        return await self._capabilities.issue_capability(
            principal, scopes, ttl_seconds=ttl_seconds, tenant=tenant
        )

    async def verify(self, token: str, req: VerifyRequest) -> VerifyResult:
        return await self._capabilities.verify(token, req)

    async def revoke_capability(self, token: str) -> RevokeCapabilityResult:
        """Revokes a capability before its ``exp``, delegating entirely to the underlying HMAC port
        (``kohaku.authz_hmac``'s ``revoke_capability``). Revocation applies only to the capability token; it has
        no effect on the bearer JWT the identity resolver handles."""
        return await self._capabilities.revoke_capability(token)


def create_jwt_authz_port(
    key: JwtKeySource,
    *,
    capability_secret: str,
    issuer: str | Sequence[str] | None = None,
    audience: str | Sequence[str] | None = None,
    clock_tolerance_seconds: int = 0,
    algorithms: Sequence[str] | None = None,
    claims: JwtClaimNames | None = None,
    map_claims: Callable[[Mapping[str, Any]], ResolvedIdentity] | None = None,
    require_tenant: bool = False,
    capability_ttl_seconds: int | None = None,
    revocation: CapabilityRevocationStore | None = None,
    require_capability_tenant: bool = False,
    now: Callable[[], float] | None = None,
    generate_jti: Callable[[], str] | None = None,
) -> JwtAuthzPort:
    """Creates the JWT AuthzPort (TS: createJwtAuthzPort).

    ``key`` .. ``require_tenant`` configure the identity resolver exactly as `create_jwt_identity_resolver` does.
    ``capability_secret``: secret for the capability tokens kohaku issues per Spec (HMAC-SHA256, from
    ``kohaku.authz_hmac``). ``capability_ttl_seconds``: default capability TTL (the host may override per
    issuance; default 600). ``revocation``: the store consulted for pre-expiry capability revocation, passed
    straight through to the HMAC port (TS: ``revocations``); defaults to a private in-memory store, a
    multi-instance deployment should inject a shared one.
    ``require_capability_tenant``: reject, in ``verify``, a capability that binds no tenant (passed straight
    through to the HMAC port's ``require_tenant``; SPEC CAP-TEN-001). Distinct from ``require_tenant``, which
    governs the bearer JWT's own tenant claim. Enable it only when every capability issuer passes the resolved
    tenant: a profile that never resolves a tenant (the MCP host) issues tenant-less capabilities, which this
    setting would then refuse.
    ``now`` / ``generate_jti``: the HMAC port's injectable clock (epoch seconds) and jti generator, for tests;
    they affect the capability tokens only, never the bearer JWT verification (PyJWT reads the wall clock).
    """
    capabilities = create_hmac_authz_port(
        capability_secret,
        ttl_seconds=capability_ttl_seconds,
        revocation=revocation,
        require_tenant=require_capability_tenant,
        now=now,
        generate_jti=generate_jti,
    )
    identity = create_jwt_identity_resolver(
        key,
        issuer=issuer,
        audience=audience,
        clock_tolerance_seconds=clock_tolerance_seconds,
        algorithms=algorithms,
        claims=claims,
        map_claims=map_claims,
        require_tenant=require_tenant,
    )
    return JwtAuthzPort(identity, capabilities)
