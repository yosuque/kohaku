"""ApprovalPort implementation (port of TS: packages/authz-hmac/src/hmac-approval-port.ts).

A homegrown HMAC-SHA256 approval token (design.md #63), structurally parallel to `authz_port.py`'s
capability token but in its own signing domain (`APPROVAL_TOKEN_PREFIX`), so an approval token and a
capability token can never be confused for one another even when signed with the same secret.

Wire compatibility: JSON has no separators (equivalent to TS's JSON.stringify) with key order
action/payloadHash/approverId/requesterId/tenant/exp/jti, base64url has no padding, and the signature is
HMAC-SHA256 over the payload string itself (not the prefix). It can be cross-verified with a TS host.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from collections.abc import Callable

from kohaku.spec import ApprovalGrant, ApprovalStore, ApprovalVerifyResult

APPROVAL_TOKEN_PREFIX = "kohaku-approval.v1."
"""Domain-separation prefix (design.md #63) -- see the TS counterpart's own doc comment for why this
alone (independent of the HMAC domain separation that already follows from signing a different message)
is enough to keep this token kind from being confused with authz_port.py's capability tokens."""

DEFAULT_APPROVAL_TTL_SECONDS = 300


def _b64url_encode(data: bytes) -> str:
    """base64url without padding (equivalent to Node's Buffer.toString("base64url"))."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    """Decodes base64url, adding back the padding."""
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


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
        store: ApprovalStore | None = None,
        now: Callable[[], float] | None = None,
    ) -> None:
        self._secret = secret.encode("utf-8")
        self._default_ttl = ttl_seconds if ttl_seconds is not None else DEFAULT_APPROVAL_TTL_SECONDS
        self._store = store
        self._now = now if now is not None else time.time

    def _sign(self, payload: str) -> str:
        digest = hmac.new(self._secret, payload.encode("utf-8"), hashlib.sha256).digest()
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
            raise ValueError("cannot issue an approval: approverId must differ from requesterId")
        claims = {
            "action": action,
            "payloadHash": payload_hash,
            "approverId": approver_id,
            "requesterId": requester_id,
            "tenant": tenant,
            "exp": int(self._now()) + (ttl_seconds if ttl_seconds is not None else self._default_ttl),
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

        if not hmac.compare_digest(signature, self._sign(payload)):
            return ApprovalVerifyResult(ok=False, reason="invalid signature")

        try:
            claims = json.loads(_b64url_decode(payload).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return ApprovalVerifyResult(ok=False, reason="malformed payload")
        if not isinstance(claims, dict):
            return ApprovalVerifyResult(ok=False, reason="malformed payload")

        exp = claims.get("exp")
        if not isinstance(exp, (int, float)) or isinstance(exp, bool):
            return ApprovalVerifyResult(ok=False, reason="malformed payload")
        if exp <= self._now():  # expired means exp <= now (matches TS's isExpired boundary)
            return ApprovalVerifyResult(ok=False, reason="approval expired")

        if claims.get("action") != action:
            return ApprovalVerifyResult(ok=False, reason="approval is bound to a different action")
        if claims.get("payloadHash") != payload_hash:
            return ApprovalVerifyResult(ok=False, reason="approval is bound to a different payload")
        if claims.get("requesterId") != requester_id:
            return ApprovalVerifyResult(ok=False, reason="approval is bound to a different requester")
        if (claims.get("tenant") or None) != (tenant or None):
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
    store: ApprovalStore | None = None,
    now: Callable[[], float] | None = None,
) -> HmacApprovalPort:
    return HmacApprovalPort(secret, ttl_seconds=ttl_seconds, store=store, now=now)


__all__ = [
    "DEFAULT_APPROVAL_TTL_SECONDS",
    "HmacApprovalPort",
    "MemoryApprovalStore",
    "create_hmac_approval_port",
]
