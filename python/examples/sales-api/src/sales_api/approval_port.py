"""ApprovalPort implementation (port of TS: packages/authz-hmac/src/hmac-approval-port.ts).

A homegrown HMAC-SHA256 approval token (design.md #63), structurally parallel to `authz_port.py`'s
capability token but in its own signing domain, so an approval token and a capability token can never be
confused for one another even when signed with the same secret: the MAC key is derived from the secret under
`APPROVAL_KEY_LABEL`, and the MAC input covers `APPROVAL_TOKEN_PREFIX` as well as the payload.

Wire compatibility: JSON has no separators (equivalent to TS's JSON.stringify) with key order
action/payloadHash/approverId/requesterId/tenant/exp/jti, base64url has no padding, and the signature is
HMAC-SHA256 (under the derived key) over prefix + payload. It can be cross-verified with a TS host.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from collections.abc import Callable

from kohaku.spec import ApprovalGrant, ApprovalIssueError, ApprovalStore, ApprovalVerifyResult

APPROVAL_TOKEN_PREFIX = "kohaku-approval.v2."
"""Token-kind prefix (design.md #63). It is part of the MAC input, and the version bump rejects every v1
token (whose MAC covered the payload only, under the raw secret). See the TS counterpart's doc comment."""

APPROVAL_KEY_LABEL = "kohaku-approval-v2"
"""Label the approval MAC key is derived under: HMAC(secret, APPROVAL_KEY_LABEL)."""

DEFAULT_APPROVAL_TTL_SECONDS = 300

DEFAULT_MAX_APPROVAL_TTL_SECONDS = 3600
"""Default upper bound on any approval lifetime this port grants, whatever TTL the caller asks for. Without
an ApprovalStore an approval is replayable until it expires, so the bound is the replay window."""


def _b64url_encode(data: bytes) -> str:
    """base64url without padding (equivalent to Node's Buffer.toString("base64url"))."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    """Decodes base64url, adding back the padding."""
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _claims_well_formed(claims: dict[str, object]) -> bool:
    exp = claims.get("exp")
    return (
        all(isinstance(claims.get(k), str) for k in ("action", "payloadHash", "approverId", "requesterId", "jti"))
        and isinstance(claims.get("tenant"), (str, type(None)))
        and isinstance(exp, (int, float))
        and not isinstance(exp, bool)
    )


class MemoryApprovalStore:
    """An in-memory ApprovalStore (jti -> expires_at). Port of TS's createMemoryApprovalStore
    (packages/authz-hmac/src/approval-store.ts). Not shared across processes -- fine for the sample /
    tests; a real deployment enforcing single-use should inject a shared store instead.

    `now` is injectable (epoch seconds) so tests can drive expiry with a fake clock.
    """

    def __init__(self, now: Callable[[], float] | None = None) -> None:
        self._now = now if now is not None else time.time
        self._consumed: dict[str, float] = {}

    def _sweep_expired(self) -> None:
        now = self._now()
        for jti in [jti for jti, expires_at in self._consumed.items() if expires_at <= now]:
            del self._consumed[jti]

    async def consume(self, jti: str, expires_at: float) -> bool:
        """Mark `jti` as consumed; return True on first use, False if it was already consumed."""
        self._sweep_expired()
        if jti in self._consumed:
            return False
        self._consumed[jti] = expires_at
        return True


class HmacApprovalPort:
    """An ApprovalPort that issues and verifies HMAC-SHA256 approval tokens (design.md #63).

    `now` is the source of the current time (seconds), defaulting to time.time; injectable in tests, the
    same convention as `authz_port.py`'s `HmacAuthzPort`.
    """

    def __init__(
        self,
        secret: str,
        *,
        ttl_seconds: int | None = None,
        max_ttl_seconds: int | None = None,
        store: ApprovalStore | None = None,
        now: Callable[[], float] | None = None,
    ) -> None:
        self._max_ttl = max_ttl_seconds if max_ttl_seconds is not None else DEFAULT_MAX_APPROVAL_TTL_SECONDS
        self._key = hmac.new(secret.encode("utf-8"), APPROVAL_KEY_LABEL.encode("utf-8"), hashlib.sha256).digest()
        self._default_ttl = ttl_seconds if ttl_seconds is not None else DEFAULT_APPROVAL_TTL_SECONDS
        self._store = store
        self._now = now if now is not None else time.time

    def _sign(self, payload: str) -> str:
        message = (APPROVAL_TOKEN_PREFIX + payload).encode("utf-8")
        digest = hmac.new(self._key, message, hashlib.sha256).digest()
        return _b64url_encode(digest)

    async def issue_approval(
        self,
        *,
        action: str,
        payload_hash: str,
        requester_id: str,
        approver_id: str,
        tenant: str | None = None,
        ttl_seconds: int | None = None,
    ) -> str:
        if approver_id == requester_id:
            # design.md #63: reject issuing a self-approval rather than leave the check to the caller.
            raise ApprovalIssueError("cannot issue an approval: approverId must differ from requesterId")
        claims = {
            "action": action,
            "payloadHash": payload_hash,
            "approverId": approver_id,
            "requesterId": requester_id,
            "tenant": tenant,
            "exp": int(self._now())
            + min(ttl_seconds if ttl_seconds is not None else self._default_ttl, self._max_ttl),
            "jti": secrets.token_urlsafe(16),
        }
        payload = _b64url_encode(
            json.dumps(claims, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        )
        return f"{APPROVAL_TOKEN_PREFIX}{payload}.{self._sign(payload)}"

    async def verify_approval(
        self, token: str, *, action: str, payload_hash: str, requester_id: str, tenant: str | None = None
    ) -> ApprovalVerifyResult:
        if not token.startswith(APPROVAL_TOKEN_PREFIX):
            return ApprovalVerifyResult(ok=False, reason="not an approval token")
        rest = token[len(APPROVAL_TOKEN_PREFIX) :]
        dot = rest.rfind(".")  # TS: lastIndexOf(".")
        if dot < 0:
            return ApprovalVerifyResult(ok=False, reason="malformed token")
        payload = rest[:dot]
        signature = rest[dot + 1 :]

        # Compare bytes: compare_digest on two str raises TypeError for a non-ASCII value.
        if not hmac.compare_digest(signature.encode("utf-8"), self._sign(payload).encode("utf-8")):
            return ApprovalVerifyResult(ok=False, reason="invalid signature")

        try:
            claims = json.loads(_b64url_decode(payload).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return ApprovalVerifyResult(ok=False, reason="malformed payload")
        if not isinstance(claims, dict):
            return ApprovalVerifyResult(ok=False, reason="malformed payload")

        # Every claim is type-checked before use (a correctly signed payload is still untrusted input); a
        # malformed one is a denial, never an exception.
        if not _claims_well_formed(claims):
            return ApprovalVerifyResult(ok=False, reason="malformed payload")
        exp = claims["exp"]
        if exp <= self._now():  # expired means exp <= now (matches TS's isExpired boundary)
            return ApprovalVerifyResult(ok=False, reason="approval expired")

        if claims.get("action") != action:
            return ApprovalVerifyResult(ok=False, reason="approval is bound to a different action")
        if claims.get("payloadHash") != payload_hash:
            return ApprovalVerifyResult(ok=False, reason="approval is bound to a different payload")
        if claims.get("requesterId") != requester_id:
            return ApprovalVerifyResult(ok=False, reason="approval is bound to a different requester")
        # `claims.get("tenant")` (not `or None`): dict.get already returns None for both a missing key and
        # an explicit JSON null, matching TS's `claims.tenant ?? undefined`. `or None` additionally folded
        # an empty-string tenant to None, silently treating "tenant: ''" as "no tenant" and letting a token
        # issued for one verify against the other (or vice versa) -- a real, if narrow, tenant-isolation
        # gap TS's `??` (which only normalizes null/undefined, never falsy strings) never had.
        if claims.get("tenant") != tenant:
            return ApprovalVerifyResult(ok=False, reason="approval is bound to a different tenant")

        approver_id = claims.get("approverId")
        if approver_id == requester_id:
            # Defense in depth: issue_approval already refuses to mint such a token.
            return ApprovalVerifyResult(ok=False, reason="self-approval is not allowed")

        jti = claims.get("jti")
        if self._store is not None:
            if not isinstance(jti, str):
                return ApprovalVerifyResult(ok=False, reason="malformed payload")
            # Not caught here -- a store failure propagates as a raised exception (fail-closed), per
            # ApprovalPort.verify_approval's contract (kohaku.spec.ports).
            first_use = await self._store.consume(jti, int(exp))
            if not first_use:
                return ApprovalVerifyResult(ok=False, reason="approval already used")

        grant = ApprovalGrant(
            action=action,
            payloadHash=payload_hash,
            approverId=str(approver_id) if approver_id is not None else "",
            requesterId=requester_id,
            tenant=tenant,
            exp=int(exp),
            jti=str(jti) if jti is not None else "",
        )
        return ApprovalVerifyResult(ok=True, grant=grant)


def create_hmac_approval_port(
    secret: str = "dev-secret-change-me",
    *,
    ttl_seconds: int | None = None,
    max_ttl_seconds: int | None = None,
    store: ApprovalStore | None = None,
    now: Callable[[], float] | None = None,
) -> HmacApprovalPort:
    return HmacApprovalPort(
        secret, ttl_seconds=ttl_seconds, max_ttl_seconds=max_ttl_seconds, store=store, now=now
    )


__all__ = [
    "DEFAULT_APPROVAL_TTL_SECONDS",
    "DEFAULT_MAX_APPROVAL_TTL_SECONDS",
    "HmacApprovalPort",
    "MemoryApprovalStore",
    "create_hmac_approval_port",
]
