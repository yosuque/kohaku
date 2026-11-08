"""JWT / OIDC identity resolution (port of packages/authz-jwt/src/identity.ts).

Verifies a JWT (signature, ``exp`` / ``nbf``, optional ``iss`` / ``aud``) with PyJWT and maps its claims to
kohaku's `Principal` (+ tenant). Nothing here touches capability tokens -- that stays with the AuthzPort.

The TS resolver is built on jose, and a token must get the same verdict here. PyJWT differs from jose in a few
defaults, which this module pins to jose's behaviour:

- PyJWT validates the type of ``sub`` / ``jti``, rejects an ``iat`` in the future, and rejects an ``aud`` claim when no
  audience is configured; jose does none of these. The decode options switch them off, so ``sub`` is decided by the
  claim mapping (``MISSING_SUBJECT``), not by the library.
- PyJWT coerces a numeric string ``exp`` / ``nbf`` / ``iat``; jose rejects any of them that is not a JSON number.
  `_check_numeric_claims` rejects them after the signature has verified.
- JWKS key selection (inline and remote) is jose's: a candidate is a key whose ``kty`` / ``crv`` fit the token's
  ``alg``, whose own ``alg`` (if any) equals it, whose ``use`` / ``key_ops`` allow verifying, and whose ``kid``
  equals the token's (any key when the token has none). Every candidate is tried. The key is handed to PyJWT as a
  ``PyJWK`` built for the token's ``alg``, so PyJWT's header-``alg``-to-key binding applies on top.
- The remote JWK set is cached for 10 minutes, refetched at most once per 30 seconds on an unknown ``kid``, and
  concurrent resolutions share one in-flight fetch (jose's ``cacheMaxAge`` / ``cooldownDuration`` / pending fetch).
  PyJWT's ``PyJWKClient`` is used only as the fetcher (https/http scheme check, no redirects, timeout).
"""

from __future__ import annotations

import asyncio
import math
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import Future
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlparse

import jwt

from kohaku.authz_hmac import is_valid_tenant_claim
from kohaku.spec import Principal

from .bearer import bearer_token

JwtIdentityErrorCode = Literal[
    "MISSING_TOKEN", "INVALID_TOKEN", "MISSING_SUBJECT", "MISSING_TENANT", "INVALID_TENANT"
]

# Minimum HS256 shared-secret length (bytes, UTF-8), enforced at construction in secret mode. 32 bytes (256 bits)
# matches HS256's own hash output size -- a shorter secret is brute-forceable well before the hash itself
# becomes the weak link.
MIN_HMAC_SECRET_BYTES = 32

# Hostnames `jwks_url` may use over plain ``http:`` (never in production; local development / tests only).
# `urllib.parse.urlparse(...).hostname` renders an IPv6 literal without its brackets.
_LOCAL_JWKS_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

# Remote JWKS tuning, jose's createRemoteJWKSet defaults: a fetch may take 5s, a fetched set is trusted for 10 minutes,
# and an unknown ``kid`` forces a refetch at most once per 30 seconds. (The ``kid`` is read before the signature is
# verified, so without the cooldown any caller could make the service hammer the issuer.)
JWKS_FETCH_TIMEOUT_SECONDS = 5
JWKS_CACHE_MAX_AGE_SECONDS = 600
JWKS_REFETCH_COOLDOWN_SECONDS = 30

_ASYMMETRIC_ALGORITHMS = ("RS256", "ES256", "EdDSA")

# The signature algorithms a JWK set can serve, with the key type (and curve) each one needs -- jose's JWS table.
# HS* is absent on purpose: a symmetric key never belongs in a JWK set.
_JWS_KEYS: dict[str, tuple[str, str | None]] = {
    **{alg: ("RSA", None) for alg in ("RS256", "RS384", "RS512", "PS256", "PS384", "PS512")},
    "ES256": ("EC", "P-256"),
    "ES384": ("EC", "P-384"),
    "ES512": ("EC", "P-521"),
    "EdDSA": ("OKP", "Ed25519"),
}

# Members that make a JWK private (or symmetric); a JWK set may carry public keys only.
_PRIVATE_JWK_MEMBERS = ("d", "p", "q", "dp", "dq", "qi", "oth", "k")

_ABSENT = object()


def _monotonic() -> float:
    """The clock for the remote JWKS cache. A module-level hook so tests can move it without touching the
    process-wide ``time.monotonic``."""
    return time.monotonic()


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
    """Verify tokens against a remote JWK set (fetched with PyJWT's ``PyJWKClient``, cached and rate limited like
    jose's ``createRemoteJWKSet``). ``audience`` is required and the URL must be ``https:`` (``http:`` only for
    localhost)."""

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


class _JwkEntry:
    """One member of a JWK set: the raw JWK, and the ``PyJWK`` objects built from it per signature algorithm."""

    def __init__(self, raw: Mapping[str, Any]) -> None:
        self.raw = raw
        self._by_alg: dict[str, jwt.PyJWK | None] = {}

    def for_alg(self, alg: str) -> jwt.PyJWK | None:
        """The key as a ``PyJWK`` for `alg` (so PyJWT binds the token's header ``alg`` to it), or None when the
        JWK cannot be loaded for that algorithm."""
        if alg not in self._by_alg:
            try:
                self._by_alg[alg] = jwt.PyJWK(dict(self.raw), algorithm=alg)
            except jwt.PyJWTError:
                self._by_alg[alg] = None
        return self._by_alg[alg]


def _parse_jwk_set(payload: object) -> list[_JwkEntry]:
    """Validates the shape of a JWK set (jose's ``isJwkSet``) and wraps its members."""
    if not isinstance(payload, Mapping) or not isinstance(payload.get("keys"), list):
        raise ValueError('a JWK set must be an object with a "keys" array')
    members = payload["keys"]
    if not all(isinstance(member, Mapping) for member in members):
        raise ValueError("every member of a JWK set must be an object")
    return [_JwkEntry(member) for member in members]


def _is_usable_jwk(jwk: Mapping[str, Any], alg: str, kid: object) -> bool:
    """Whether `jwk` can verify a token with header ``alg`` / ``kid`` (jose's ``isUsableJWK``). The caller has
    checked that `alg` is in `_JWS_KEYS`."""
    kty, crv = _JWS_KEYS[alg]
    if any(member in jwk for member in _PRIVATE_JWK_MEMBERS):
        return False
    if "ext" in jwk and not isinstance(jwk["ext"], bool):
        return False
    if "key_ops" in jwk:
        ops = jwk["key_ops"]
        if not (
            isinstance(ops, list)
            and all(isinstance(op, str) for op in ops)
            and len(set(ops)) == len(ops)
            and "verify" in ops
        ):
            return False
    if jwk.get("kty") != kty:
        return False
    if kid is not _ABSENT and not (isinstance(kid, str) and kid == jwk.get("kid")):
        return False
    if "alg" in jwk and jwk["alg"] != alg:
        return False
    if "use" in jwk and jwk["use"] != "sig":
        return False
    return crv is None or jwk.get("crv") == crv


def _select_keys(entries: Sequence[_JwkEntry], alg: str, kid: object) -> list[jwt.PyJWK]:
    selected: list[jwt.PyJWK] = []
    for entry in entries:
        if _is_usable_jwk(entry.raw, alg, kid) and (key := entry.for_alg(alg)) is not None:
            selected.append(key)
    return selected


class _LocalJwks:
    """An inline JWK set."""

    def __init__(self, jwks: Mapping[str, Any]) -> None:
        self._entries = _parse_jwk_set(jwks)

    async def candidates(self, alg: str, kid: object) -> list[jwt.PyJWK]:
        return _select_keys(self._entries, alg, kid)


class _RemoteJwks:
    """A remote JWK set, cached and rate limited like jose's ``createRemoteJWKSet``: fetched on first use and again
    once older than `JWKS_CACHE_MAX_AGE_SECONDS`; refetched on an unknown ``kid`` only when the last fetch is older
    than `JWKS_REFETCH_COOLDOWN_SECONDS`; and concurrent callers share one in-flight fetch -- success or failure --
    instead of queueing a fetch each (a hung issuer costs everybody one timeout, not N of them)."""

    def __init__(self, url: str) -> None:
        # cache_jwk_set=False: only `fetch_data` (scheme check, no redirects, timeout, error wrapping) is used;
        # this class owns the cache so the policy above is explicit and identical to jose's.
        self._client = jwt.PyJWKClient(url, cache_jwk_set=False, timeout=JWKS_FETCH_TIMEOUT_SECONDS)
        self._lock = threading.Lock()
        self._entries: list[_JwkEntry] | None = None
        self._fetched_at: float | None = None
        self._inflight: Future[None] | None = None

    def _fresh_for(self, seconds: float) -> bool:
        fetched_at = self._fetched_at
        return fetched_at is not None and _monotonic() < fetched_at + seconds

    def _fetch_job(self, inflight: Future[None]) -> None:
        """Fetch, parse and cache-store as ONE job whose completion fulfils `inflight`. It runs on its own
        thread, owned by neither the request that started it nor any event loop, so cancelling that request (or
        any waiter) can neither orphan the fetch nor hand the others an error that was not theirs."""
        try:
            entries = _parse_jwk_set(self._client.fetch_data())
            with self._lock:
                self._entries = entries
                self._fetched_at = _monotonic()
                self._inflight = None
            inflight.set_result(None)
        except BaseException as e:
            with self._lock:
                self._inflight = None
            inflight.set_exception(e)

    async def _reload(self) -> None:
        with self._lock:
            inflight = self._inflight
            if inflight is None:
                inflight = self._inflight = Future()
                # Mark it RUNNING at once: a RUNNING future cannot be cancelled, so `asyncio.wrap_future`'s
                # cancel-propagation (a cancelled awaiter calls `cancel()` on the future it wraps) is a no-op
                # instead of cancelling the fetch for every sibling, and `set_result` / `set_exception` can
                # never hit InvalidStateError. (Fixing it at the shared future's source makes every present
                # and future awaiter safe, whereas `asyncio.shield` would have to be remembered at each await
                # site.)
                inflight.set_running_or_notify_cancel()
                try:
                    threading.Thread(
                        target=self._fetch_job,
                        args=(inflight,),
                        name="kohaku-jwks-fetch",
                        daemon=True,
                    ).start()
                except BaseException as e:
                    self._inflight = None
                    inflight.set_exception(e)
                    raise
        # The request that started the fetch awaits it exactly like every other: its cancellation only
        # drops that one request.
        await asyncio.wrap_future(inflight)

    async def candidates(self, alg: str, kid: object) -> list[jwt.PyJWK]:
        if self._entries is None or not self._fresh_for(JWKS_CACHE_MAX_AGE_SECONDS):
            await self._reload()
        assert self._entries is not None
        selected = _select_keys(self._entries, alg, kid)
        if not selected and not self._fresh_for(JWKS_REFETCH_COOLDOWN_SECONDS):
            await self._reload()
            assert self._entries is not None
            selected = _select_keys(self._entries, alg, kid)
        return selected


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
            # The capability port refuses a tenant that is over-long or holds control characters (SPEC
            # CAP-TEN-001); refusing it here turns what would be a 500 at capability issuance into a 401, and
            # never downgrades a malformed tenant to "no tenant" (a different data scope).
            if not is_valid_tenant_claim(tenant):
                raise JwtIdentityError(
                    "INVALID_TENANT", f'token "{names.tenant}" claim is not a valid tenant id'
                )
            return ResolvedIdentity(principal=principal, tenant=tenant)
        if require_tenant:
            raise JwtIdentityError("MISSING_TENANT", f'token has no "{names.tenant}" claim')
        return ResolvedIdentity(principal=principal)

    return map_claims


def _check_numeric_claims(payload: Mapping[str, Any]) -> None:
    """``exp`` / ``nbf`` / ``iat``, when present, must be JSON numbers (jose's ``validateNumericDate``); PyJWT would
    coerce a numeric string. ``bool`` is an ``int`` in Python and not a number in JSON; NaN / Infinity are not
    finite."""
    for claim in ("exp", "nbf", "iat"):
        if claim not in payload:
            continue
        value = payload[claim]
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
        ):
            raise jwt.InvalidTokenError(f'"{claim}" claim must be a number')


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
        self._secret: bytes | None = None
        self._jwks: _LocalJwks | _RemoteJwks | None = None
        default_algorithms: Sequence[str]
        if isinstance(key, JwtSecretKey):
            if len(key.secret.encode("utf-8")) < MIN_HMAC_SECRET_BYTES:
                raise ValueError(
                    f"key.secret must be at least {MIN_HMAC_SECRET_BYTES} bytes "
                    "(HS256 requires a strong shared secret)"
                )
            self._secret = key.secret.encode("utf-8")
            default_algorithms = ("HS256",)
        else:
            if audience is None:
                # jwks / jwks_url mode: a JWKS-configured resolver typically talks to a third-party issuer that
                # mints tokens for other audiences too, so an unset `audience` here would accept a token never
                # meant for this service.
                raise ValueError("audience is required when key is jwks_url or jwks")
            if isinstance(key, JwtJwksKey):
                self._jwks = _LocalJwks(key.jwks)
            else:
                _assert_jwks_url_allowed(key.jwks_url)
                self._jwks = _RemoteJwks(key.jwks_url)
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

    def _decode(self, token: str, key: Any) -> dict[str, Any]:
        return jwt.decode(
            token,
            key,
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

    async def _verify(self, token: str) -> dict[str, Any]:
        header = jwt.get_unverified_header(token)
        alg = header.get("alg")
        # Checked before any key lookup: a token naming an algorithm this resolver does not allow must not cost a
        # JWKS fetch (the header is attacker-controlled until the signature verifies).
        if not isinstance(alg, str) or alg not in self._algorithms:
            raise jwt.InvalidAlgorithmError("the token's alg is not an allowed algorithm")
        keys: Sequence[Any]
        if self._secret is not None:
            keys = [self._secret]
        else:
            assert self._jwks is not None
            if alg not in _JWS_KEYS:
                raise jwt.InvalidAlgorithmError("the token's alg cannot be verified with a JWK set")
            keys = await self._jwks.candidates(alg, header.get("kid", _ABSENT))
            if not keys:
                raise jwt.PyJWKSetError("no key in the JWK set matches the token")
        last_error: jwt.PyJWTError | None = None
        for key in keys:
            try:
                payload = self._decode(token, key)
            except jwt.PyJWTError as e:
                last_error = e
                continue
            _check_numeric_claims(payload)
            return payload
        assert last_error is not None
        raise last_error

    async def resolve(self, token: str) -> ResolvedIdentity:
        try:
            payload = await self._verify(token)
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
    ``require_tenant`` and the tenant-id check -- a caller supplying it is responsible for its own tenant handling.
    ``require_tenant``: a token with no (or an empty) tenant claim fails with ``MISSING_TENANT`` instead of
    resolving without a tenant (default False; default mapping only). A tenant claim that is not a valid tenant id
    (over 256 UTF-16 code units or holding a control character) always fails with ``INVALID_TENANT``.
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
