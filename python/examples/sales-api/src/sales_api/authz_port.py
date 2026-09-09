"""AuthzPort implementation (port of TS: apps/sample-api/src/ports/authz-port.ts).

An in-house HMAC-SHA256 capability token (on-behalf-of). Emphasizing pedagogy, the structure is transparent:
base64url(payload).base64url(hmac). payload = {sub, scopes: [{kind, ref}], exp}.

Wire compatibility: the JSON has no separators (equivalent to TS's JSON.stringify) with key order sub/scopes/exp,
base64url has no padding, and the signature is HMAC-SHA256 over the payload string itself. It can be cross-verified
with a TS host in the future.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from collections.abc import Callable

from kohaku.spec import Principal, Scope, VerifyRequest, VerifyResult


def _b64url_encode(data: bytes) -> str:
    """base64url without padding (equivalent to Node's Buffer.toString("base64url"))."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    """Decodes base64url, adding back the padding."""
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class HmacAuthzPort:
    """An AuthzPort that issues and verifies HMAC-SHA256 capability tokens.

    now is the source of the current time (in seconds), defaulting to time.time. A fixed time can be injected in tests
    to check expiry (TS references Date.now directly; an extension for the Python version's testability).
    """

    def __init__(self, secret: str, *, now: Callable[[], float] | None = None) -> None:
        self._secret = secret.encode("utf-8")
        self._now = now if now is not None else time.time

    def _sign(self, payload: str) -> str:
        digest = hmac.new(self._secret, payload.encode("utf-8"), hashlib.sha256).digest()
        return _b64url_encode(digest)

    async def issue_capability(
        self, principal: Principal, scopes: list[Scope], *, ttl_seconds: int | None = None
    ) -> str:
        payload_obj = {
            "sub": principal.id,
            "scopes": [{"kind": s.kind, "ref": s.ref} for s in scopes],
            "exp": int(self._now()) + (ttl_seconds if ttl_seconds is not None else 600),
        }
        # Like TS's JSON.stringify: no separators, non-ASCII kept as UTF-8.
        payload = _b64url_encode(
            json.dumps(payload_obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        )
        return f"{payload}.{self._sign(payload)}"

    async def verify(self, token: str, req: VerifyRequest) -> VerifyResult:
        dot = token.rfind(".")  # TS: lastIndexOf(".")
        if dot < 0:
            return VerifyResult(ok=False, reason="malformed token")
        payload = token[:dot]
        signature = token[dot + 1 :]

        # The signature is verified against the received payload string itself (not re-serialized).
        # This allows verifying externally (TS) issued tokens too, preserving interoperability.
        if not hmac.compare_digest(signature, self._sign(payload)):
            return VerifyResult(ok=False, reason="invalid signature")

        try:
            claims = json.loads(_b64url_decode(payload).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return VerifyResult(ok=False, reason="malformed payload")
        if not isinstance(claims, dict):
            return VerifyResult(ok=False, reason="malformed payload")

        exp = claims.get("exp")
        if not isinstance(exp, (int, float)) or isinstance(exp, bool):
            return VerifyResult(ok=False, reason="malformed payload")
        if exp < int(self._now()):
            return VerifyResult(ok=False, reason="capability expired")

        scopes = claims.get("scopes")
        scope_list = scopes if isinstance(scopes, list) else []
        # Scope matching is exact (a prefix match would let ?region=us permit ?region=usa).
        granted = any(
            isinstance(s, dict) and s.get("kind") == req.kind and s.get("ref") == req.ref
            for s in scope_list
        )
        if not granted:
            return VerifyResult(ok=False, reason=f"scope does not cover {req.kind}:{req.ref}")

        sub = claims.get("sub")
        return VerifyResult(ok=True, principal=Principal(id=sub if isinstance(sub, str) else ""))


def create_hmac_authz_port(
    secret: str = "dev-secret-change-me", *, now: Callable[[], float] | None = None
) -> HmacAuthzPort:
    return HmacAuthzPort(secret, now=now)


__all__ = ["HmacAuthzPort", "create_hmac_authz_port"]
