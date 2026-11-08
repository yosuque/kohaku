"""JWT / OIDC identity resolution (port of packages/authz-jwt/src/identity.ts).

Verifies a JWT (signature, ``exp`` / ``nbf``, optional ``iss`` / ``aud``) with PyJWT and maps its claims to
kohaku's `Principal` (+ tenant). Nothing here touches capability tokens -- that stays with the AuthzPort.

PyJWT validates more than jose (the TS library) does by default, so the decode options below switch off the
checks jose does not make (``sub`` type, ``jti`` type, ``iat`` in the future, and an ``aud`` check when no audience
is configured). That keeps the two resolvers' verdicts identical for the same token: ``sub`` is decided by the
claim mapping (``MISSING_SUBJECT``), not by the library.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlparse

import jwt

from kohaku.spec import Principal

from .bearer import bearer_token

JwtIdentityErrorCode = Literal[
    "MISSING_TOKEN", "INVALID_TOKEN", "MISSING_SUBJECT", "MISSING_TENANT"
]

# Minimum HS256 shared-secret length (bytes, UTF-8), enforced at construction in secret mode. 32 bytes (256 bits)
# matches HS256's own hash output size -- a shorter secret is brute-forceable well before the hash itself
# becomes the weak link.
MIN_HMAC_SECRET_BYTES = 32

# Hostnames `jwks_url` may use over plain ``http:`` (never in production; local development / tests only).
# `urllib.parse.urlparse(...).hostname` renders an IPv6 literal without its brackets.
_LOCAL_JWKS_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

# Seconds a JWKS fetch may take. jose's createRemoteJWKSet defaults to 5s as well. (The other jose default,
# the 30s cooldown between refetches forced by an unknown ``kid``, is PyJWKClient's own default too -- the
# ``kid`` is read before the signature is verified, so without it any caller could make the service hammer the
# issuer; hence the ``PyJWT>=2.14.0`` floor of the ``jwt`` extra.)
JWKS_FETCH_TIMEOUT_SECONDS = 5

_ASYMMETRIC_ALGORITHMS = ("RS256", "ES256", "EdDSA")


@dataclass(frozen=True)
class JwtSecretKey:
    """Verify HS256 (by default) tokens with a shared secret."""

    secret: str


@dataclass(frozen=True)
class JwtJwksKey:
    """Verify tokens against an inline JWK set (``{"keys": [...]}``). ``audience`` is required."""

    jwks: Mapping[str, Any]


@dataclass(frozen=True)
class JwtJwksUrlKey:
    """Verify tokens against a remote JWK set (fetched and cached with PyJWT's ``PyJWKClient``). ``audience`` is
    required and the URL must be ``https:`` (``http:`` only for localhost)."""

    jwks_url: str


JwtKeySource = JwtSecretKey | JwtJwksKey | JwtJwksUrlKey


@dataclass(frozen=True)
class JwtClaimNames:
    """Claim names the default mapping reads. Override for issuers that namespace custom claims (Auth0-style
    URLs)."""

    subject: str = "sub"
    name: str = "name"
    roles: str = "roles"
    tenant: str = "tenant"


@dataclass(frozen=True)
class ResolvedIdentity:
    principal: Principal
    tenant: str | None = None


class JwtIdentityError(Exception):
    """A token that cannot be turned into an identity. ``code`` says why; the cause (a PyJWT error) is chained."""

    def __init__(self, code: JwtIdentityErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: JwtIdentityErrorCode = code


def _assert_jwks_url_allowed(jwks_url: str) -> None:
    """Rejects an ``http:`` `jwks_url` unless it targets a local host (localhost / 127.0.0.1 / ::1) -- fetching a
    JWKS over plain HTTP from a real issuer would let a network attacker substitute their own keys and forge
    tokens this resolver would then accept. ``https:`` is always allowed; any other scheme (``file:``, which
    urllib would happily open, included) is not. Raised at construction, so a misconfiguration is caught before
    the first token is verified."""
    url = urlparse(jwks_url)
    if url.scheme == "https":
        return
    if url.scheme == "http" and url.hostname in _LOCAL_JWKS_HOSTS:
        return
    raise ValueError(
        "jwks_url must use https: (http: is only allowed for localhost/127.0.0.1/::1), "
        f'got "{url.scheme}://{url.hostname or ""}"'
    )


def _local_jwks_key_for(jwk_set: jwt.PyJWKSet, token: str) -> jwt.PyJWK:
    """Picks the key of an inline JWK set for `token`: the one whose ``kid`` equals the token's, or -- when the
    token names none -- the set's only signing key. Anything else is ambiguous or unknown, hence an error."""
    kid = jwt.get_unverified_header(token).get("kid")
    candidates = [
        key
        for key in jwk_set.keys
        if key.public_key_use in (None, "sig") and (kid is None or key.key_id == kid)
    ]
    if len(candidates) != 1:
        raise jwt.PyJWKSetError(
            f"no unique signing key for kid {kid!r} ({len(candidates)} candidates in the JWK set)"
        )
    return candidates[0]


def _roles_of(value: object) -> list[str] | None:
    if isinstance(value, list):
        return [v for v in value if isinstance(v, str)]
    if isinstance(value, str):
        return value.split()
    return None


def _default_map(
    names: JwtClaimNames, require_tenant: bool
) -> Callable[[Mapping[str, Any]], ResolvedIdentity]:
    def map_claims(payload: Mapping[str, Any]) -> ResolvedIdentity:
        subject = payload.get(names.subject)
        if not isinstance(subject, str) or subject == "":
            raise JwtIdentityError("MISSING_SUBJECT", f'token has no "{names.subject}" claim')
        name = payload.get(names.name)
        principal = Principal(
            id=subject,
            name=name if isinstance(name, str) else None,
            roles=_roles_of(payload.get(names.roles)),
        )
        tenant = payload.get(names.tenant)
        if isinstance(tenant, str) and tenant != "":
            return ResolvedIdentity(principal=principal, tenant=tenant)
        if require_tenant:
            raise JwtIdentityError("MISSING_TENANT", f'token has no "{names.tenant}" claim')
        return ResolvedIdentity(principal=principal)

    return map_claims


class JwtIdentityResolver:
    """Turns a bearer JWT into a `ResolvedIdentity`. Build one with `create_jwt_identity_resolver`."""

    def __init__(
        self,
        key: JwtKeySource,
        *,
        issuer: str | Sequence[str] | None = None,
        audience: str | Sequence[str] | None = None,
        clock_tolerance_seconds: int = 0,
        algorithms: Sequence[str] | None = None,
        claims: JwtClaimNames | None = None,
        map_claims: Callable[[Mapping[str, Any]], ResolvedIdentity] | None = None,
        require_tenant: bool = False,
    ) -> None:
        if isinstance(key, JwtSecretKey):
            if len(key.secret.encode("utf-8")) < MIN_HMAC_SECRET_BYTES:
                raise ValueError(
                    f"key.secret must be at least {MIN_HMAC_SECRET_BYTES} bytes "
                    "(HS256 requires a strong shared secret)"
                )
        elif audience is None:
            # jwks / jwks_url mode: a JWKS-configured resolver typically talks to a third-party issuer that
            # mints tokens for other audiences too, so an unset `audience` here would accept a token never
            # meant for this service.
            raise ValueError("audience is required when key is jwks_url or jwks")

        self._signing_key: Callable[[str], Any]
        self._blocking = False
        if isinstance(key, JwtSecretKey):
            secret = key.secret.encode("utf-8")
            self._signing_key = lambda _token: secret
            default_algorithms: Sequence[str] = ("HS256",)
        elif isinstance(key, JwtJwksKey):
            try:
                jwk_set = jwt.PyJWKSet.from_dict(dict(key.jwks))
            except jwt.PyJWTError as e:
                raise ValueError(f"jwks is not a usable JWK set: {e}") from e
            self._signing_key = lambda token: _local_jwks_key_for(jwk_set, token).key
            default_algorithms = _ASYMMETRIC_ALGORITHMS
        else:
            _assert_jwks_url_allowed(key.jwks_url)
            client = jwt.PyJWKClient(key.jwks_url, timeout=JWKS_FETCH_TIMEOUT_SECONDS)
            self._signing_key = lambda token: client.get_signing_key_from_jwt(token).key
            self._blocking = True  # PyJWKClient fetches with urllib: keep it off the event loop
            default_algorithms = _ASYMMETRIC_ALGORITHMS

        self._algorithms = list(algorithms if algorithms is not None else default_algorithms)
        self._issuer = issuer
        self._audience = audience
        self._leeway = clock_tolerance_seconds
        self._map = (
            map_claims
            if map_claims is not None
            else _default_map(claims if claims is not None else JwtClaimNames(), require_tenant)
        )

    def _verify(self, token: str) -> dict[str, Any]:
        return jwt.decode(
            token,
            self._signing_key(token),
            algorithms=self._algorithms,
            issuer=self._issuer,
            audience=self._audience,
            leeway=self._leeway,
            options={
                "verify_aud": self._audience is not None,
                "verify_sub": False,
                "verify_jti": False,
                "verify_iat": False,
            },
        )

    async def resolve(self, token: str) -> ResolvedIdentity:
        try:
            payload = (
                await asyncio.to_thread(self._verify, token)
                if self._blocking
                else self._verify(token)
            )
        except Exception as e:
            raise JwtIdentityError("INVALID_TOKEN", "token verification failed") from e
        return self._map(payload)

    async def from_authorization_header(self, header: str | None) -> ResolvedIdentity:
        token = bearer_token(header)
        if token is None:
            raise JwtIdentityError("MISSING_TOKEN", "no Bearer token in the Authorization header")
        return await self.resolve(token)


def create_jwt_identity_resolver(
    key: JwtKeySource,
    *,
    issuer: str | Sequence[str] | None = None,
    audience: str | Sequence[str] | None = None,
    clock_tolerance_seconds: int = 0,
    algorithms: Sequence[str] | None = None,
    claims: JwtClaimNames | None = None,
    map_claims: Callable[[Mapping[str, Any]], ResolvedIdentity] | None = None,
    require_tenant: bool = False,
) -> JwtIdentityResolver:
    """Creates the JWT identity resolver (TS: createJwtIdentityResolver).

    ``key``: `JwtSecretKey` (HS256 shared secret, at least 32 bytes), `JwtJwksKey` (inline JWK set) or
    `JwtJwksUrlKey` (remote JWK set). ``audience`` is REQUIRED for the two JWKS key sources (a JWKS-configured
    resolver typically talks to a third-party issuer that mints tokens for other audiences too, so skipping the
    ``aud`` check there would accept a token never meant for this service); optional for a secret.
    ``clock_tolerance_seconds``: leeway on ``exp`` / ``nbf`` (default 0). ``algorithms``: the allowed ``alg``
    values (default ``["HS256"]`` for a secret, ``["RS256", "ES256", "EdDSA"]`` for a JWK set).
    ``claims``: claim names for the default mapping. ``map_claims``: a full override of the claims -> identity
    mapping (the verified payload is passed in); it bypasses the default mapping entirely, including
    ``require_tenant`` -- a caller supplying it is responsible for its own tenant requirement.
    ``require_tenant``: a token with no (or an empty) tenant claim fails with ``MISSING_TENANT`` instead of
    resolving without a tenant (default False; default mapping only).
    """
    return JwtIdentityResolver(
        key,
        issuer=issuer,
        audience=audience,
        clock_tolerance_seconds=clock_tolerance_seconds,
        algorithms=algorithms,
        claims=claims,
        map_claims=map_claims,
        require_tenant=require_tenant,
    )
