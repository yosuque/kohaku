"""HMAC-SHA256 capability-token AuthzPort (port of packages/authz-hmac/src/hmac-authz-port.ts).

A homegrown capability token (on-behalf-of: the host acts under the user's delegated authority). The structure
is transparent, prioritizing didactic value: ``base64url(payload).base64url(hmac)`` with
``payload = {sub, scopes: [{kind, ref}], exp, jti, tenant?}``.

Wire compatibility with the TS port is byte-level: the JSON has no separators (like ``JSON.stringify``) with the
key order ``sub / scopes / exp / jti [/ tenant]``, non-ASCII is kept as UTF-8, base64url has no padding, and the
signature is HMAC-SHA256 over the payload string itself (so a TS-issued token verifies here and the reverse).
The cross-language golden (spec/test/fixtures/cross-language-canonical.json, ``authzHmac``) pins the bytes.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import secrets
from collections.abc import Callable

from kohaku.spec import (
    DEFAULT_CAPABILITY_TTL_SECONDS,
    CapabilityRevocationStore,
    Principal,
    RevokeCapabilityResult,
    Scope,
    VerifyRequest,
    VerifyResult,
)

from .revocation_store import create_memory_revocation_store
from .time import is_expired, now_seconds

# Longest tenant claim `issue_capability` signs and `verify` accepts (TS: MAX_CAPABILITY_TENANT_LENGTH), counted
# in UTF-16 code units like TS's `String.length` (an astral-plane character counts as 2).
MAX_CAPABILITY_TENANT_LENGTH = 256


def b64url_encode(data: bytes) -> str:
    """base64url without padding (equivalent to Node's ``Buffer.toString("base64url")``)."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(s: str) -> bytes:
    """Decodes base64url, adding back the padding."""
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def is_utf8_encodable(s: str) -> bool:
    """False for a str holding a lone surrogate (which ``str.encode("utf-8")`` rejects). TS encodes such a token
    with a replacement character, so its signature simply does not match; a token that cannot be encoded must
    likewise be a denial here, never an exception."""
    try:
        s.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def is_valid_tenant_claim(tenant: str) -> bool:
    """A tenant claim is a short identifier: at most 256 characters and no control characters (SPEC
    CAP-TEN-001), the same rule as TS's isValidTenantClaim."""
    return len(
        tenant.encode("utf-16-le", errors="surrogatepass")
    ) // 2 <= MAX_CAPABILITY_TENANT_LENGTH and not any(
        ord(ch) < 0x20 or ord(ch) == 0x7F for ch in tenant
    )


def _is_number(value: object) -> bool:
    """A finite JSON number (not a bool). ``json.loads`` accepts NaN / Infinity and ``NaN <= now`` is False:
    without the finiteness check a NaN ``exp`` would never expire. Mirrors TS's ``Number.isFinite``."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:  # an int too large for a float: TS would have parsed it as Infinity
        return False


def _claims_well_formed(value: object) -> bool:
    """Mirrors TS's isHmacClaims. A correctly signed payload is still untrusted (the secret may be shared with
    another token kind), so every claim is type-checked before use; a malformed one is a denial."""
    if not isinstance(value, dict):
        return False
    if not isinstance(value.get("sub"), str) or not _is_number(value.get("exp")):
        return False
    # Absent is fine; an explicit null is malformed (TS: `c.jti === undefined || typeof c.jti === "string"`).
    if "jti" in value and not isinstance(value["jti"], str):
        return False
    if "tenant" in value and not (
        isinstance(value["tenant"], str) and is_valid_tenant_claim(value["tenant"])
    ):
        return False
    scopes = value.get("scopes")
    return isinstance(scopes, list) and all(
        isinstance(s, dict) and isinstance(s.get("kind"), str) and isinstance(s.get("ref"), str)
        for s in scopes
    )


class HmacAuthzPort:
    """An AuthzPort that issues and verifies HMAC-SHA256 capability tokens, with pre-expiry revocation.

    Build one with `create_hmac_authz_port`. ``now`` (epoch seconds, defaults to the wall clock) and
    ``generate_jti`` (defaults to 16 random bytes, base64url) are injectable so tests and the cross-language
    golden can pin the time and the jti; TS references ``Date.now`` / ``randomBytes`` directly.
    """

    def __init__(
        self,
        secret: str,
        *,
        ttl_seconds: int | None = None,
        revocation: CapabilityRevocationStore | None = None,
        require_jti: bool = False,
        require_tenant: bool = False,
        now: Callable[[], float] | None = None,
        generate_jti: Callable[[], str] | None = None,
    ) -> None:
        self._secret = secret.encode("utf-8")
        self._default_ttl = (
            ttl_seconds if ttl_seconds is not None else DEFAULT_CAPABILITY_TTL_SECONDS
        )
        self._now: Callable[[], float] = now if now is not None else now_seconds
        # The default store shares the port's clock: with an injected `now` the store must agree on when an
        # entry expires (TS has one global clock, so it never needs to say this).
        self._revocation: CapabilityRevocationStore = (
            revocation if revocation is not None else create_memory_revocation_store(self._now)
        )
        self._require_jti = require_jti
        self._require_tenant = require_tenant
        self._generate_jti: Callable[[], str] = (
            generate_jti if generate_jti is not None else (lambda: secrets.token_urlsafe(16))
        )

    def _sign(self, payload: str) -> str:
        digest = hmac.new(self._secret, payload.encode("utf-8"), hashlib.sha256).digest()
        return b64url_encode(digest)

    def _verify_signature_and_decode(self, token: str) -> tuple[dict[str, object] | None, str]:
        """Verifies the signature and decodes the payload; shared by `verify` and `revoke_capability`.
        Returns ``(claims, "")`` on success, ``(None, reason)`` on failure."""
        dot = token.rfind(".")  # TS: lastIndexOf(".")
        if dot < 0:
            return None, "malformed token"
        payload = token[:dot]
        signature = token[dot + 1 :]

        # The signature is verified against the received payload string itself (not re-serialized), so an
        # externally (TS) issued token verifies. Compare bytes: compare_digest on two str raises TypeError for
        # a non-ASCII value.
        if not (is_utf8_encodable(signature) and is_utf8_encodable(payload)):
            return None, "invalid signature"
        if not hmac.compare_digest(signature.encode("utf-8"), self._sign(payload).encode("utf-8")):
            return None, "invalid signature"

        try:
            parsed = json.loads(b64url_decode(payload).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None, "malformed payload"
        if not _claims_well_formed(parsed):
            return None, "malformed payload"
        return parsed, ""

    async def issue_capability(
        self,
        principal: Principal,
        scopes: list[Scope],
        *,
        ttl_seconds: int | None = None,
        tenant: str | None = None,
    ) -> str:
        if tenant is not None and not is_valid_tenant_claim(tenant):
            raise ValueError(
                f"capability tenant must be at most {MAX_CAPABILITY_TENANT_LENGTH} characters "
                "with no control characters"
            )
        claims: dict[str, object] = {
            "sub": principal.id,
            "scopes": [{"kind": s.kind, "ref": s.ref} for s in scopes],
            "exp": int(self._now())
            + (ttl_seconds if ttl_seconds is not None else self._default_ttl),
            "jti": self._generate_jti(),
        }
        # An empty tenant is no tenant: it is never signed, so verify cannot return an empty-string tenant.
        if tenant:
            claims["tenant"] = tenant
        # Like TS's JSON.stringify: no separators, non-ASCII kept as UTF-8.
        payload = b64url_encode(
            json.dumps(claims, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        )
        return f"{payload}.{self._sign(payload)}"

    async def verify(self, token: str, req: VerifyRequest) -> VerifyResult:
        claims, reason = self._verify_signature_and_decode(token)
        if claims is None:
            return VerifyResult(ok=False, reason=reason)

        exp = claims["exp"]
        assert isinstance(exp, (int, float))
        if is_expired(exp, self._now()):
            return VerifyResult(ok=False, reason="capability expired")
        jti = claims.get("jti")
        if self._require_jti and jti is None:
            return VerifyResult(ok=False, reason="capability lacks jti")
        # An empty tenant claim (never signed by this issuer) counts as no tenant.
        raw_tenant = claims.get("tenant")
        tenant = raw_tenant if isinstance(raw_tenant, str) and raw_tenant != "" else None
        if self._require_tenant and tenant is None:
            return VerifyResult(ok=False, reason="capability lacks tenant")
        scopes = claims["scopes"]
        assert isinstance(scopes, list)
        # Scope matching is exact (a prefix match would let ?region=us permit ?region=usa).
        granted = any(s["kind"] == req.kind and s["ref"] == req.ref for s in scopes)
        if not granted:
            return VerifyResult(ok=False, reason=f"scope does not cover {req.kind}:{req.ref}")
        # Scope is evaluated before consulting the revocation store: an out-of-scope request never pays for a
        # store round trip, and a store outage only affects requests that would otherwise have succeeded. A
        # store failure is not caught here -- it propagates, per AuthzPort.verify's contract: verify raises
        # only on infrastructure failure, and a raised verify is fail-closed (the host maps it to a 5xx).
        if isinstance(jti, str) and await self._revocation.is_revoked(jti):
            return VerifyResult(ok=False, reason="capability revoked")
        sub = claims["sub"]
        assert isinstance(sub, str)
        return VerifyResult(ok=True, principal=Principal(id=sub), tenant=tenant)

    async def revoke_capability(self, token: str) -> RevokeCapabilityResult:
        """Revokes a capability before its ``exp``. The token's signature is verified first, so a caller cannot
        revoke a ``jti`` it merely guessed -- a tampered or foreign token is rejected. An already-expired token
        is a no-op success (``already_expired=True``). A token minted before ``jti`` existed carries none and
        therefore cannot be revoked (``NO_JTI``): it simply verifies until it expires on its own, deliberately,
        so a rolling deploy does not invalidate an old instance's already-issued tokens. A revocation-store
        failure is a coded ``STORE_ERROR``, never raised."""
        claims, reason = self._verify_signature_and_decode(token)
        if claims is None:
            if reason == "invalid signature":
                return RevokeCapabilityResult(ok=False, code="INVALID_SIGNATURE", reason=reason)
            return RevokeCapabilityResult(ok=False, code="MALFORMED", reason=reason)

        exp = claims["exp"]
        assert isinstance(exp, (int, float))
        if is_expired(exp, self._now()):
            # Nothing to revoke: the token can no longer verify regardless, so writing a revocation record
            # for it would just grow the store for nothing. Idempotent success, not a failure.
            return RevokeCapabilityResult(ok=True, already_expired=True)
        jti = claims.get("jti")
        if not isinstance(jti, str):
            return RevokeCapabilityResult(
                ok=False, code="NO_JTI", reason="token predates revocation support"
            )
        try:
            await self._revocation.revoke(jti, int(exp))
        except Exception as e:
            return RevokeCapabilityResult(
                ok=False, code="STORE_ERROR", reason=f"revocation store failed: {e}"
            )
        return RevokeCapabilityResult(ok=True)


def create_hmac_authz_port(
    secret: str,
    *,
    ttl_seconds: int | None = None,
    require_jti: bool = False,
    require_tenant: bool = False,
    revocation: CapabilityRevocationStore | None = None,
    now: Callable[[], float] | None = None,
    generate_jti: Callable[[], str] | None = None,
) -> HmacAuthzPort:
    """Creates the HMAC capability AuthzPort (TS: createHmacAuthzPort).

    ``now`` and ``generate_jti`` are TEST-ONLY injection points (TS has none): never set them in production -- a
    non-random ``generate_jti`` collides jti values, which breaks revocation, and a skewed ``now`` shifts every expiry.

    ``ttl_seconds``: default capability lifetime when `issue_capability` is given none (600).
    ``revocation``: the store consulted by `verify` / `revoke_capability` for pre-expiry revocation; defaults to
    a private in-memory store on the port's clock (fine for one instance, a multi-instance deployment should
    inject a shared one).
    ``require_jti``: reject a token with no ``jti`` ("capability lacks jti"); turn on only once no pre-upgrade
    token can still be in circulation. ``require_tenant``: reject a token with no ``tenant`` ("capability lacks
    tenant"); for a multi-tenant deployment whose every issuer passes the resolved tenant (SPEC CAP-TEN-001).
    """
    return HmacAuthzPort(
        secret,
        ttl_seconds=ttl_seconds,
        revocation=revocation,
        require_jti=require_jti,
        require_tenant=require_tenant,
        now=now,
        generate_jti=generate_jti,
    )
