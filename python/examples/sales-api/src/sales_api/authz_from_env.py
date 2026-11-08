"""Environment-driven selection of the sample's AuthzPort (port of the AuthzPort half of
apps/sample-api/src/ports/from-env.ts). Everything here is sample wiring: a product picks its adapters in code.

- ``KOHAKU_AUTHZ``: ``hmac`` (default, the header-based demo identity) or ``jwt``.
- ``KOHAKU_CAPABILITY_SECRET``: the capability-token secret (and the approval token's, which derives its MAC key
  from it under its own label). Defaults to a publicly known demo value, which ``jwt`` refuses to run on.
- ``KOHAKU_JWT_SECRET`` / ``KOHAKU_JWT_JWKS_URL``: the bearer-JWT key source (a shared HS256 secret, or a remote
  JWKS; one of them is required under ``jwt``). ``KOHAKU_JWT_AUDIENCE`` (required with a JWKS URL),
  ``KOHAKU_JWT_ISSUER``.
- ``KOHAKU_JWT_REQUIRE_TENANT``: a token with no tenant claim is rejected unless this is ``0``.

``kohaku.authz_jwt`` (PyJWT) is imported only on the ``jwt`` path, so the ``hmac`` demo needs no ``jwt`` extra.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from kohaku.authz_hmac import create_hmac_authz_port
from kohaku.spec import AuthzPort, CapabilityRevocationStore

from .storage_from_env import storage_kind_from_env

if TYPE_CHECKING:
    from kohaku.authz_jwt import JwtIdentityResolver

AuthzKind = Literal["hmac", "jwt"]

DEFAULT_CAPABILITY_SECRET = "dev-secret-change-me"
"""A file/hmac demo convenience only (see `create_authz_from_env`)."""


@dataclass(frozen=True)
class AuthzFromEnv:
    kind: AuthzKind
    authz: AuthzPort
    capability_secret: str
    identity: JwtIdentityResolver | None = None
    """Present only for ``jwt``: the resolver the request-identity hooks use."""


def capability_secret_from_env(env: Mapping[str, str]) -> str:
    """Resolves ``KOHAKU_CAPABILITY_SECRET``. An empty or whitespace-only value is treated exactly like an unset
    one (falls back to the fixed default) rather than being passed through as a literal near-empty secret --
    stripping here only decides *whether* the env value counts as set, the value returned is still the unstripped
    original. Shared by the capability token (hmac or jwt) and the approval-token port (its MAC key is derived
    from the secret under its own label, which separates its domain from the capability token's, so reusing the
    same secret is by design, not a shortcut)."""
    raw = env.get("KOHAKU_CAPABILITY_SECRET")
    return raw if raw is not None and raw.strip() != "" else DEFAULT_CAPABILITY_SECRET


def create_authz_from_env(
    env: Mapping[str, str],
    *,
    require_capability_tenant: bool = False,
    revocation: CapabilityRevocationStore | None = None,
) -> AuthzFromEnv:
    """Builds the AuthzPort the environment selects.

    ``require_capability_tenant``: under ``KOHAKU_AUTHZ=jwt``, reject a capability that binds no tenant
    (authz_jwt's ``require_capability_tenant``, SPEC CAP-TEN-001). Only a REST host that issues every capability
    with the request's resolved tenant should set this (``__main__`` does); the MCP profile never resolves a
    tenant, so its capabilities are tenant-less and it must leave this off. Still subject to
    ``KOHAKU_JWT_REQUIRE_TENANT``: a deployment that opted out of tenant-bearing JWTs (``0``) gets no capability
    tenant requirement either.
    ``revocation``: the store backing pre-expiry capability revocation (default: a private in-memory one).
    """
    capability_secret = capability_secret_from_env(env)
    kind = env.get("KOHAKU_AUTHZ", "hmac")
    # The fixed fallback is a demo convenience only. Once either storage or authz leaves the single-process,
    # header-based demo shape -- a shared redis/postgres backend, or JWT-verified identity -- a capability token
    # signed with a secret every clone of this repo also knows is a real forgery risk, not a quickstart nicety, so
    # refuse to start rather than run on it.
    if capability_secret == DEFAULT_CAPABILITY_SECRET and (
        kind == "jwt" or storage_kind_from_env(env) in ("redis", "postgres")
    ):
        raise ValueError(
            "KOHAKU_CAPABILITY_SECRET must be set to a real secret when "
            "KOHAKU_STORAGE=redis|postgres or KOHAKU_AUTHZ=jwt"
        )
    if kind == "hmac":
        return AuthzFromEnv(
            kind="hmac",
            authz=create_hmac_authz_port(capability_secret, revocation=revocation),
            capability_secret=capability_secret,
        )
    if kind != "jwt":
        raise ValueError(f'KOHAKU_AUTHZ must be hmac or jwt, got "{kind}"')

    from kohaku.authz_jwt import JwtJwksUrlKey, JwtSecretKey, create_jwt_authz_port

    secret = env.get("KOHAKU_JWT_SECRET") or None
    jwks_url = env.get("KOHAKU_JWT_JWKS_URL") or None
    if secret is None and jwks_url is None:
        raise ValueError("KOHAKU_AUTHZ=jwt requires KOHAKU_JWT_SECRET or KOHAKU_JWT_JWKS_URL")
    audience = env.get("KOHAKU_JWT_AUDIENCE") or None
    if secret is None and audience is None:
        # Named env-shaped error ahead of authz_jwt's own generic "audience is required when key is jwks_url
        # or jwks" construction error, so a misconfiguration points at the right env var immediately.
        raise ValueError("KOHAKU_AUTHZ=jwt with KOHAKU_JWT_JWKS_URL requires KOHAKU_JWT_AUDIENCE")
    # Default true (a token with no tenant claim is rejected) whenever JWT is in play: the promotion / fixation
    # / lineage governance plane is separated per tenant, so silently falling back to "no tenant" is far more
    # likely to be a misconfigured issuer than an intentional single-tenant deployment. Set
    # KOHAKU_JWT_REQUIRE_TENANT=0 to opt out (e.g. a genuinely single-tenant deployment).
    require_tenant = env.get("KOHAKU_JWT_REQUIRE_TENANT") != "0"
    if secret is not None:
        key: JwtSecretKey | JwtJwksUrlKey = JwtSecretKey(secret)
    else:
        assert jwks_url is not None  # one of the two is set (checked above)
        key = JwtJwksUrlKey(jwks_url)
    port = create_jwt_authz_port(
        key,
        capability_secret=capability_secret,
        issuer=env.get("KOHAKU_JWT_ISSUER") or None,
        audience=audience,
        require_tenant=require_tenant,
        # A tenant-bearing JWT yields a tenant-bound capability (the REST host passes the resolved tenant to
        # issuance), so a REST deployment that requires the former can require the latter. Both stay off when
        # the deployment opted out of tenants, and off for a host that never resolves one (the MCP profile).
        require_capability_tenant=require_tenant and require_capability_tenant,
        revocation=revocation,
    )
    return AuthzFromEnv(
        kind="jwt", authz=port, capability_secret=capability_secret, identity=port.identity
    )
