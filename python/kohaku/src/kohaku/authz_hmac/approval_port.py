"""HMAC-SHA256 approval-token ApprovalPort (port of packages/authz-hmac/src/hmac-approval-port.ts).

A homegrown approval token (design.md #63), structurally parallel to `authz_port.py`'s capability token but in
its own signing domain, so an approval token and a capability token can never be confused for one another even
when signed with the same secret: the MAC key is derived from the secret under `APPROVAL_KEY_LABEL`, and the MAC
input covers `APPROVAL_TOKEN_PREFIX` as well as the payload.

Wire compatibility with the TS port is byte-level: the JSON has no separators (like ``JSON.stringify``) with the
key order ``action / payloadHash / approverId / requesterId [/ tenant] / exp / jti`` (``tenant`` is omitted, not
``null``, when the request carries none), base64url has no padding, and the signature is HMAC-SHA256 (under the
derived key) over prefix + payload. The cross-language golden (``authzHmac``) pins the bytes.

Stateless: the token itself carries every claim `verify_approval` checks, so no server-side lookup is needed to
verify a fresh token -- single-use enforcement (replay prevention) is the only optional stateful behavior, and
it is delegated entirely to the caller-supplied `ApprovalStore`.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import secrets
from collections.abc import Callable

from kohaku.spec import (
    DEFAULT_APPROVAL_TTL_SECONDS,
    ApprovalGrant,
    ApprovalIssueError,
    ApprovalStore,
    ApprovalVerifyResult,
)

from .authz_port import b64url_decode, b64url_encode
from .time import is_expired, now_seconds

APPROVAL_TOKEN_PREFIX = "kohaku-approval.v2."
"""Token-kind prefix (design.md #63). Human-readable marker only: what actually keeps this token kind from being
accepted by `HmacAuthzPort` (and the converse) is cryptographic -- the derived MAC key, and the prefix being part
of the MAC input (so a signature cannot be lifted onto a token of another kind or version). The version is part of
the prefix: a v1 token (whose MAC covered the payload only, under the raw secret) fails the prefix check."""

APPROVAL_KEY_LABEL = "kohaku-approval-v2"
"""Label the approval MAC key is derived under: HMAC(secret, APPROVAL_KEY_LABEL)."""

DEFAULT_MAX_APPROVAL_TTL_SECONDS = 3600
"""Default upper bound on any approval lifetime this port grants, whatever TTL the caller asks for. Without an
ApprovalStore an approval is replayable until it expires, so the bound is the replay window."""


def _claims_well_formed(value: object) -> bool:
    """Mirrors TS's isApprovalClaims: every claim is type-checked before use; a malformed one is a denial."""
    if not isinstance(value, dict):
        return False
    exp = value.get("exp")
    return (
        all(
            isinstance(value.get(k), str)
            for k in ("action", "payloadHash", "approverId", "requesterId", "jti")
        )
        and isinstance(value.get("tenant"), (str, type(None)))
        and isinstance(exp, (int, float))
        and not isinstance(exp, bool)
        # json.loads accepts NaN / Infinity, and `NaN <= now` is False: without this a NaN exp would never
        # expire. Mirrors TS's Number.isFinite.
        and math.isfinite(exp)
    )


class HmacApprovalPort:
    """An ApprovalPort that issues and verifies HMAC-SHA256 approval tokens (design.md #63).

    Build one with `create_hmac_approval_port`. ``now`` (epoch seconds, defaults to the wall clock) and
    ``generate_jti`` are injectable for tests and the cross-language golden, like `HmacAuthzPort`.
    """

    def __init__(
        self,
        secret: str,
        *,
        ttl_seconds: int | None = None,
        max_ttl_seconds: int | None = None,
        store: ApprovalStore | None = None,
        now: Callable[[], float] | None = None,
        generate_jti: Callable[[], str] | None = None,
    ) -> None:
        self._default_ttl = ttl_seconds if ttl_seconds is not None else DEFAULT_APPROVAL_TTL_SECONDS
        self._max_ttl = (
            max_ttl_seconds if max_ttl_seconds is not None else DEFAULT_MAX_APPROVAL_TTL_SECONDS
        )
        self._store = store
        self._key = hmac.new(
            secret.encode("utf-8"), APPROVAL_KEY_LABEL.encode("utf-8"), hashlib.sha256
        ).digest()
        self._now: Callable[[], float] = now if now is not None else now_seconds
        self._generate_jti: Callable[[], str] = (
            generate_jti if generate_jti is not None else (lambda: secrets.token_urlsafe(16))
        )

    def _sign(self, payload: str) -> str:
        message = (APPROVAL_TOKEN_PREFIX + payload).encode("utf-8")
        return b64url_encode(hmac.new(self._key, message, hashlib.sha256).digest())

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
            # design.md #63: an ApprovalPort MUST reject issuing a self-approval rather than leave the check to
            # the caller (which could otherwise forget it and let a requester rubber-stamp their own action).
            raise ApprovalIssueError(
                "cannot issue an approval: approverId must differ from requesterId"
            )
        claims: dict[str, object] = {
            "action": action,
            "payloadHash": payload_hash,
            "approverId": approver_id,
            "requesterId": requester_id,
        }
        # TS's JSON.stringify drops an undefined tenant; emitting `"tenant":null` would not be byte-identical.
        if tenant is not None:
            claims["tenant"] = tenant
        claims["exp"] = int(self._now()) + min(
            ttl_seconds if ttl_seconds is not None else self._default_ttl, self._max_ttl
        )
        claims["jti"] = self._generate_jti()
        payload = b64url_encode(
            json.dumps(claims, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        )
        return f"{APPROVAL_TOKEN_PREFIX}{payload}.{self._sign(payload)}"

    async def verify_approval(
        self,
        token: str,
        *,
        action: str,
        payload_hash: str,
        requester_id: str,
        tenant: str | None = None,
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
            claims = json.loads(b64url_decode(payload).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return ApprovalVerifyResult(ok=False, reason="malformed payload")
        # A correctly signed payload is still untrusted input (the secret may be shared with another token
        # kind), so a malformed one is a denial, never an exception.
        if not _claims_well_formed(claims):
            return ApprovalVerifyResult(ok=False, reason="malformed payload")

        exp = claims["exp"]
        if is_expired(exp, self._now()):
            return ApprovalVerifyResult(ok=False, reason="approval expired")
        if claims["action"] != action:
            return ApprovalVerifyResult(ok=False, reason="approval is bound to a different action")
        if claims["payloadHash"] != payload_hash:
            return ApprovalVerifyResult(ok=False, reason="approval is bound to a different payload")
        if claims["requesterId"] != requester_id:
            return ApprovalVerifyResult(
                ok=False, reason="approval is bound to a different requester"
            )
        # `dict.get` already folds a missing key and an explicit JSON null to None (TS: `claims.tenant ??
        # undefined`), and -- like `??` -- keeps an empty string distinct from "no tenant" (`or None` would
        # not), so a token issued for one never verifies against the other.
        if claims.get("tenant") != tenant:
            return ApprovalVerifyResult(ok=False, reason="approval is bound to a different tenant")
        if claims["approverId"] == claims["requesterId"]:
            # Defense in depth: issue_approval already refuses to mint such a token, but a hand-crafted or
            # pre-this-check token should not verify just because it happens to carry matching ids.
            return ApprovalVerifyResult(ok=False, reason="self-approval is not allowed")
        # Single-use enforcement is consulted last (only once every other check has passed), so a request that
        # would be denied anyway never spends a use. A store failure is not caught here -- it propagates, per
        # ApprovalPort.verify_approval's contract: it raises only on infrastructure failure, and a raised
        # verify_approval is fail-closed (the host maps it to a 5xx, never to an allow).
        if self._store is not None:
            first_use = await self._store.consume(claims["jti"], int(exp))
            if not first_use:
                return ApprovalVerifyResult(ok=False, reason="approval already used")
        return ApprovalVerifyResult(
            ok=True,
            grant=ApprovalGrant(
                action=claims["action"],
                payloadHash=claims["payloadHash"],
                approverId=claims["approverId"],
                requesterId=claims["requesterId"],
                tenant=claims.get("tenant"),
                exp=int(exp),
                jti=claims["jti"],
            ),
        )


def create_hmac_approval_port(
    secret: str,
    *,
    ttl_seconds: int | None = None,
    max_ttl_seconds: int | None = None,
    store: ApprovalStore | None = None,
    now: Callable[[], float] | None = None,
    generate_jti: Callable[[], str] | None = None,
) -> HmacApprovalPort:
    """Creates the HMAC approval-token ApprovalPort (TS: createHmacApprovalPort).

    ``ttl_seconds``: default approval lifetime (300). ``max_ttl_seconds``: upper bound on any lifetime granted --
    a larger requested (or configured default) TTL is clamped to it, not rejected (3600). ``store``: optional
    persistence for single-use enforcement (design.md #63); omitted, a token stays usable repeatedly until it
    expires (fine for a demo, a production deployment gating a real destructive action should configure one).
    """
    return HmacApprovalPort(
        secret,
        ttl_seconds=ttl_seconds,
        max_ttl_seconds=max_ttl_seconds,
        store=store,
        now=now,
        generate_jti=generate_jti,
    )
