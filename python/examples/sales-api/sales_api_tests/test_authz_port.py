"""Tests for AuthzPort (port of TS: apps/sample-api/test/authz-port.test.ts + HMAC round-trip, expiry, wire format).

Scope matching is exact (a prefix match would let ?region=us permit ?region=usa, and annotate permit annotateAll).
Tokens are wire-compatible with TS (base64url(payload).base64url(hmac), payload = {sub, scopes, exp}).
"""

from __future__ import annotations

import asyncio
import base64
import json

from kohaku.spec import Principal, Scope, VerifyRequest
from sales_api.authz_port import create_hmac_authz_port

PRINCIPAL = Principal(id="u", roles=["user"])


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class TestScopeExactMatch:
    def test_read_scope_does_not_cross_value_boundary(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            cap = await authz.issue_capability(
                PRINCIPAL, [Scope(kind="read", ref="query://sales/summary?region=us")]
            )
            ok = await authz.verify(
                cap, VerifyRequest(kind="read", ref="query://sales/summary?region=us")
            )
            assert ok.ok is True
            ng = await authz.verify(
                cap, VerifyRequest(kind="read", ref="query://sales/summary?region=usa")
            )
            assert ng.ok is False

        asyncio.run(run())

    def test_write_scope_does_not_prefix_match(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            cap = await authz.issue_capability(PRINCIPAL, [Scope(kind="write", ref="annotate")])
            assert (await authz.verify(cap, VerifyRequest(kind="write", ref="annotate"))).ok is True
            assert (
                await authz.verify(cap, VerifyRequest(kind="write", ref="annotateAll"))
            ).ok is False

        asyncio.run(run())


class TestRoundtripAndWire:
    def test_roundtrip_returns_principal(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port()  # default secret
            cap = await authz.issue_capability(
                PRINCIPAL, [Scope(kind="read", ref="query://sales/kpi?fy=2026")]
            )
            result = await authz.verify(
                cap, VerifyRequest(kind="read", ref="query://sales/kpi?fy=2026")
            )
            assert result.ok is True
            assert result.principal is not None and result.principal.id == "u"

        asyncio.run(run())

    def test_wire_format_payload_structure(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            cap = await authz.issue_capability(
                PRINCIPAL, [Scope(kind="write", ref="annotate")], ttl_seconds=600
            )
            parts = cap.split(".")
            assert len(parts) == 2  # payload.signature
            payload = json.loads(_b64url_decode(parts[0]).decode("utf-8"))
            assert list(payload.keys()) == ["sub", "scopes", "exp"]
            assert payload["sub"] == "u"
            assert payload["scopes"] == [{"kind": "write", "ref": "annotate"}]
            assert isinstance(payload["exp"], int)

        asyncio.run(run())

    def test_cross_verifies_secret_dependent(self) -> None:
        """A token issued with a different secret fails verification (signature-dependent)."""

        async def run() -> None:
            issuer = create_hmac_authz_port("secret-a")
            verifier = create_hmac_authz_port("secret-b")
            cap = await issuer.issue_capability(
                PRINCIPAL, [Scope(kind="read", ref="query://sales/summary")]
            )
            result = await verifier.verify(
                cap, VerifyRequest(kind="read", ref="query://sales/summary")
            )
            assert result.ok is False
            assert result.reason == "invalid signature"

        asyncio.run(run())


class TestExpiryAndMalformed:
    def test_expired_capability(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            cap = await authz.issue_capability(
                PRINCIPAL, [Scope(kind="read", ref="query://sales/kpi")], ttl_seconds=-10
            )
            result = await authz.verify(cap, VerifyRequest(kind="read", ref="query://sales/kpi"))
            assert result.ok is False
            assert result.reason == "capability expired"

        asyncio.run(run())

    def test_malformed_token(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            result = await authz.verify(
                "no-dot-here", VerifyRequest(kind="read", ref="query://sales/kpi")
            )
            assert result.ok is False
            assert result.reason == "malformed token"

        asyncio.run(run())

    def test_tampered_signature(self) -> None:
        async def run() -> None:
            authz = create_hmac_authz_port("test-secret")
            cap = await authz.issue_capability(
                PRINCIPAL, [Scope(kind="read", ref="query://sales/kpi")]
            )
            payload = cap.split(".")[0]
            result = await authz.verify(
                f"{payload}.tampered", VerifyRequest(kind="read", ref="query://sales/kpi")
            )
            assert result.ok is False
            assert result.reason == "invalid signature"

        asyncio.run(run())
