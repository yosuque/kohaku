"""SPEC CAP-TEN-001 on the REST data plane (port of packages/host-rest/test/capability-tenant.test.ts,
the tenant cases of tenant.test.ts and promotions.test.ts, and the binding rate-limit key cases of
rate-limit-middleware.test.ts).

The tenant signed into the capability is authoritative over the one the request itself resolves
(deps.tenant); a disagreement is a 403 CAPABILITY_DENIED; a tenant-less (pre-upgrade) capability falls back to
deps.tenant; and the rate-limit key is the verified (tenant, capability sub, route_class), taken only after
the capability verified.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from starlette.requests import Request

from kohaku.host_core import PolicyRateLimiter, PolicyRateLimiterTakeParams, RateLimitedInfo
from kohaku.lineage import now_iso
from kohaku.spec import (
    ApprovalGrant,
    ApprovalVerifyResult,
    InvocationContext,
    JsonObject,
    LineageActor,
    LineageEventRecord,
    OperationDescriptor,
    Principal,
    RateLimitResult,
    Scope,
    VerifyRequest,
    VerifyResult,
)

from .conftest import PREFIX, Harness, build_harness


def _url(path: str) -> str:
    return f"{PREFIX}{path}"


def _header_tenant(request: Request) -> str | None:
    return request.headers.get("x-kohaku-tenant") or None


def _resolve(harness: Harness, token: str, headers: dict[str, str] | None = None) -> Any:
    return harness.client.get(
        _url("/binding/resolve"),
        params={"ref": harness.ref},
        headers={"authorization": f"Bearer {token}", **(headers or {})},
    )


def _act(
    harness: Harness, token: str, body: dict[str, Any], headers: dict[str, str] | None = None
) -> Any:
    return harness.client.post(
        _url("/binding/action"),
        json=body,
        headers={"authorization": f"Bearer {token}", **(headers or {})},
    )


def _contexts(harness: Harness) -> list[InvocationContext]:
    return harness.domain.contexts  # type: ignore[attr-defined,no-any-return]


class _StubLimiter(PolicyRateLimiter):
    def __init__(self, result: RateLimitResult | None = None) -> None:
        self.result = result or RateLimitResult(allow=True)
        self.calls: list[PolicyRateLimiterTakeParams] = []

    async def take(self, params: PolicyRateLimiterTakeParams) -> RateLimitResult:
        self.calls.append(params)
        return self.result


class TestCapabilityTenantIsAuthoritative:
    def test_resolve_passes_the_capability_tenant_even_when_deps_tenant_resolves_nothing(
        self, tmp_path: Path
    ) -> None:
        harness = build_harness(tmp_path, tenant=_header_tenant)
        token = harness.issue([Scope(kind="read", ref=harness.ref)], tenant="acme")
        assert _resolve(harness, token).status_code == 200
        assert _contexts(harness)[0].tenant == "acme"

    def test_resolve_accepts_a_request_tenant_equal_to_the_capability_tenant(
        self, tmp_path: Path
    ) -> None:
        harness = build_harness(tmp_path, tenant=_header_tenant)
        token = harness.issue([Scope(kind="read", ref=harness.ref)], tenant="acme")
        assert _resolve(harness, token, {"x-kohaku-tenant": "acme"}).status_code == 200
        assert _contexts(harness)[0].tenant == "acme"

    def test_resolve_denies_a_mismatching_request_tenant_before_the_domain_port(
        self, tmp_path: Path
    ) -> None:
        harness = build_harness(tmp_path, tenant=_header_tenant)
        token = harness.issue([Scope(kind="read", ref=harness.ref)], tenant="acme")
        res = _resolve(harness, token, {"x-kohaku-tenant": "globex"})
        assert res.status_code == 403
        error = res.json()["error"]
        assert error["code"] == "CAPABILITY_DENIED"
        assert error["message"] == "capability tenant does not match the request tenant"
        assert _contexts(harness) == []

    def test_resolve_with_a_tenant_less_capability_falls_back_to_deps_tenant(
        self, tmp_path: Path
    ) -> None:
        harness = build_harness(tmp_path, tenant=_header_tenant)
        token = harness.issue([Scope(kind="read", ref=harness.ref)])
        assert _resolve(harness, token, {"x-kohaku-tenant": "globex"}).status_code == 200
        assert _contexts(harness)[0].tenant == "globex"

    def test_resolve_with_no_tenant_anywhere_leaves_the_invocation_tenant_unset(
        self, tmp_path: Path
    ) -> None:
        harness = build_harness(tmp_path)
        token = harness.issue([Scope(kind="read", ref=harness.ref)])
        assert _resolve(harness, token).status_code == 200
        assert _contexts(harness)[0].tenant is None

    def test_action_denies_a_mismatching_request_tenant(self, tmp_path: Path) -> None:
        harness = build_harness(tmp_path, tenant=_header_tenant)
        token = harness.issue([Scope(kind="write", ref="annotate")], tenant="acme")
        res = _act(
            harness, token, {"action": "annotate", "payload": {}}, {"x-kohaku-tenant": "globex"}
        )
        assert res.status_code == 403
        assert res.json()["error"]["code"] == "CAPABILITY_DENIED"
        assert _contexts(harness) == []

    def test_action_with_a_tenant_less_capability_uses_deps_tenant(self, tmp_path: Path) -> None:
        harness = build_harness(tmp_path, tenant=_header_tenant)
        token = harness.issue([Scope(kind="write", ref="annotate")])
        res = _act(
            harness, token, {"action": "annotate", "payload": {}}, {"x-kohaku-tenant": "globex"}
        )
        assert res.status_code == 200
        assert _contexts(harness)[0].tenant == "globex"

    def test_action_passes_the_capability_tenant_to_the_approval_binding_audit_and_domain(
        self, tmp_path: Path
    ) -> None:
        verify_kwargs: list[dict[str, Any]] = []
        invoked: list[dict[str, Any]] = []
        contexts: list[InvocationContext] = []

        class _Domain:
            async def list_operations(self) -> list[OperationDescriptor]:
                return [OperationDescriptor(name="delete", description="d", tier="approve")]

            async def invoke(self, op: str, args: JsonObject, ctx: InvocationContext) -> object:
                contexts.append(ctx)
                return {"ok": True}

        class _Approvals:
            async def issue_approval(self, **kwargs: Any) -> str:
                raise AssertionError("not used")

            async def verify_approval(self, token: str, **kwargs: Any) -> ApprovalVerifyResult:
                verify_kwargs.append(kwargs)
                return ApprovalVerifyResult(
                    ok=True,
                    grant=ApprovalGrant(
                        action="delete",
                        payloadHash=kwargs["payload_hash"],
                        approverId="approver-1",
                        requesterId=kwargs["requester_id"],
                        exp=9999999999,
                        jti="j",
                    ),
                )

        class _Recorder:
            async def invoked(self, **kwargs: Any) -> None:
                invoked.append(kwargs)

            async def denied(self, **kwargs: Any) -> None: ...

            async def approval_requested(self, **kwargs: Any) -> None: ...

            async def approved(self, **kwargs: Any) -> None: ...

        harness = build_harness(
            tmp_path,
            domain=_Domain(),
            approvals=_Approvals(),
            action_audit_recorder=_Recorder(),
            tenant=_header_tenant,
        )
        token = harness.issue([Scope(kind="write", ref="delete")], tenant="acme")
        res = _act(harness, token, {"action": "delete", "payload": {}, "approval": "tok"})
        assert res.status_code == 200
        assert contexts[0].tenant == "acme"
        assert verify_kwargs[0]["tenant"] == "acme"
        assert invoked[0]["tenant"] == "acme"


class TestRateLimitAfterVerification:
    def test_resolve_counts_the_capability_tenant_and_sub_not_the_request_identity(
        self, tmp_path: Path
    ) -> None:
        limiter = _StubLimiter()

        harness = build_harness(
            tmp_path,
            rate_limiter=limiter,
            tenant=_header_tenant,
            auth=lambda _r: Principal(id="header-user", roles=["admin"]),
        )
        token = harness.issue([Scope(kind="read", ref=harness.ref)], tenant="acme", sub="cap-user")
        assert _resolve(harness, token).status_code == 200
        assert [(c.tenant, c.principal, c.routeClass) for c in limiter.calls] == [
            ("acme", "cap-user", "resolve")
        ]

    def test_action_counts_the_capability_tenant_and_sub(self, tmp_path: Path) -> None:
        limiter = _StubLimiter()
        harness = build_harness(tmp_path, rate_limiter=limiter)
        token = harness.issue([Scope(kind="write", ref="annotate")], tenant="acme", sub="cap-user")
        assert _act(harness, token, {"action": "annotate", "payload": {}}).status_code == 200
        assert [(c.tenant, c.principal, c.routeClass) for c in limiter.calls] == [
            ("acme", "cap-user", "action")
        ]

    def test_a_denied_or_missing_capability_never_takes_a_token(self, tmp_path: Path) -> None:
        limiter = _StubLimiter(RateLimitResult(allow=False, retryAfterMs=1000))
        harness = build_harness(tmp_path, rate_limiter=limiter)
        assert _resolve(harness, "unknown-capability").status_code == 403
        assert (
            _act(harness, "unknown-capability", {"action": "annotate", "payload": {}}).status_code
            == 403
        )
        no_bearer = harness.client.get(_url("/binding/resolve"), params={"ref": harness.ref})
        assert no_bearer.status_code == 401
        assert limiter.calls == []

    def test_a_denial_is_429_and_notifies_on_rate_limited_with_the_capability_identity(
        self, tmp_path: Path
    ) -> None:
        limiter = _StubLimiter(RateLimitResult(allow=False, retryAfterMs=1000))
        seen: list[RateLimitedInfo] = []
        harness = build_harness(tmp_path, rate_limiter=limiter, on_rate_limited=seen.append)
        token = harness.issue([Scope(kind="read", ref=harness.ref)], tenant="acme", sub="cap-user")
        res = _resolve(harness, token)
        assert res.status_code == 429
        assert res.headers.get("Retry-After") == "1"
        assert _contexts(harness) == []
        assert len(seen) == 1
        assert (seen[0].tenant, seen[0].principal, seen[0].routeClass) == (
            "acme",
            "cap-user",
            "resolve",
        )


class TestIssuanceBindsTheResolvedTenant:
    def test_compose_binds_the_tenant_deps_tenant_resolved(self, tmp_path: Path) -> None:
        harness = build_harness(tmp_path, tenant=_header_tenant)
        res = harness.client.post(
            _url("/compose"),
            json={"intent": harness.intent_body},
            headers={"x-kohaku-tenant": "acme"},
        )
        assert res.status_code == 200
        assert harness.authz.issue_kwargs == [{"tenant": "acme"}]

    def test_compose_stream_binds_the_resolved_tenant_too(self, tmp_path: Path) -> None:
        harness = build_harness(tmp_path, tenant=_header_tenant)
        res = harness.client.post(
            _url("/compose/stream"),
            json={"intent": harness.intent_body},
            headers={"x-kohaku-tenant": "acme"},
        )
        assert res.status_code == 200
        assert harness.authz.issue_kwargs
        assert all(kw == {"tenant": "acme"} for kw in harness.authz.issue_kwargs)

    def test_compose_without_a_resolved_tenant_binds_none(self, tmp_path: Path) -> None:
        harness = build_harness(tmp_path)
        assert (
            harness.client.post(_url("/compose"), json={"intent": harness.intent_body}).status_code
            == 200
        )
        assert harness.authz.issue_kwargs == [{"tenant": None}]

    def test_promotion_preview_binds_the_resolved_tenant(self, tmp_path: Path) -> None:
        harness = build_harness(tmp_path, tenant=_header_tenant)
        asyncio.run(
            harness.storage.append_lineage(
                LineageEventRecord(
                    id="gen-art",
                    ts=now_iso(),
                    actor=LineageActor(kind="model", model="fake"),
                    type="component.generated",
                    tenant="acme",
                    payload={
                        "artifactId": "art",
                        "canonical": "sales.custom",
                        "request": "Custom sales view",
                        "ref": harness.ref,
                        "html": "<!DOCTYPE html><html><body>art</body></html>",
                        "artifactSha256": "sha256:" + "0" * 64,
                    },
                )
            )
        )
        res = harness.client.post(
            _url("/promotions/art/preview"), headers={"x-kohaku-tenant": "acme"}
        )
        assert res.status_code == 200
        assert harness.authz.issue_kwargs == [{"tenant": "acme"}]


class _LegacyAuthz:
    """A port written before the `tenant` keyword existed (the signature a custom port may still have)."""

    def __init__(self) -> None:
        self.issued = 0

    async def issue_capability(
        self, principal: Principal, scopes: list[Scope], *, ttl_seconds: int | None = None
    ) -> str:
        self.issued += 1
        return f"legacy-{self.issued}"

    async def verify(self, token: str, req: VerifyRequest) -> VerifyResult:
        return VerifyResult(ok=True, principal=Principal(id="legacy"))


class _KwargsAuthz:
    def __init__(self) -> None:
        self.kwargs: list[dict[str, Any]] = []

    async def issue_capability(
        self, principal: Principal, scopes: list[Scope], **kwargs: Any
    ) -> str:
        self.kwargs.append(kwargs)
        return "kw"

    async def verify(self, token: str, req: VerifyRequest) -> VerifyResult:
        return VerifyResult(ok=True, principal=Principal(id="kw"))


class TestLegacySignatureAuthz:
    """A custom port without a `tenant` keyword degrades to tenant-less issuance (detected with
    inspect.signature, never by catching TypeError) and is reported once through on_error."""

    def test_legacy_port_with_a_resolved_tenant_is_issued_without_it_and_reported_once(
        self, tmp_path: Path
    ) -> None:
        errors: list[Any] = []
        harness = build_harness(tmp_path, tenant=_header_tenant, on_error=errors.append)
        legacy = _LegacyAuthz()
        harness.deps.authz = legacy  # type: ignore[assignment]  # a legacy signature, on purpose
        for _ in range(2):
            res = harness.client.post(
                _url("/compose"),
                json={"intent": harness.intent_body},
                headers={"x-kohaku-tenant": "acme"},
            )
            assert res.status_code == 200
            assert res.json()["capability"].startswith("legacy-")
        assert legacy.issued == 2
        reported = [e for e in errors if e.endpoint == "capability.tenant_unsupported"]
        assert len(reported) == 1
        assert "_LegacyAuthz" in str(reported[0].error)

    def test_legacy_port_without_a_tenant_is_never_reported(self, tmp_path: Path) -> None:
        errors: list[Any] = []
        harness = build_harness(tmp_path, on_error=errors.append)
        harness.deps.authz = _LegacyAuthz()  # type: ignore[assignment]  # a legacy signature, on purpose
        res = harness.client.post(_url("/compose"), json={"intent": harness.intent_body})
        assert res.status_code == 200
        assert [e for e in errors if e.endpoint == "capability.tenant_unsupported"] == []

    def test_a_port_taking_kwargs_receives_the_tenant(self, tmp_path: Path) -> None:
        harness = build_harness(tmp_path, tenant=_header_tenant)
        kw = _KwargsAuthz()
        harness.deps.authz = kw
        res = harness.client.post(
            _url("/compose"),
            json={"intent": harness.intent_body},
            headers={"x-kohaku-tenant": "acme"},
        )
        assert res.status_code == 200
        assert kw.kwargs and kw.kwargs[0].get("tenant") == "acme"

    def test_authz_accepts_tenant_inspects_the_signature(self) -> None:
        from kohaku.host_core import authz_accepts_tenant

        assert authz_accepts_tenant(_LegacyAuthz()) is False  # type: ignore[arg-type]
        assert authz_accepts_tenant(_KwargsAuthz()) is True
        assert authz_accepts_tenant(FakeAuthzForInspect()) is True


class FakeAuthzForInspect:
    async def issue_capability(
        self,
        principal: Principal,
        scopes: list[Scope],
        *,
        ttl_seconds: int | None = None,
        tenant: str | None = None,
    ) -> str:
        return "x"

    async def verify(self, token: str, req: VerifyRequest) -> VerifyResult:
        return VerifyResult(ok=True)


class TestCheapRejectionsAndRateLimitAccounting:
    def test_a_missing_bearer_is_401_before_the_body_is_read(self, tmp_path: Path) -> None:
        harness = build_harness(tmp_path)
        res = harness.client.post(
            _url("/binding/action"),
            content="{not json",
            headers={"content-type": "application/json"},
        )
        assert res.status_code == 401
        assert res.json()["error"]["code"] == "CAPABILITY_REQUIRED"

    def test_a_request_tenant_equal_to_the_capability_passes_and_no_tenant_leaves_it_unset(
        self, tmp_path: Path
    ) -> None:
        bound = build_harness(tmp_path / "a", tenant=_header_tenant)
        token = bound.issue([Scope(kind="write", ref="annotate")], tenant="acme")
        res = _act(bound, token, {"action": "annotate", "payload": {}}, {"x-kohaku-tenant": "acme"})
        assert res.status_code == 200
        assert _contexts(bound)[0].tenant == "acme"

        none = build_harness(tmp_path / "b")
        token = none.issue([Scope(kind="write", ref="annotate")])
        assert _act(none, token, {"action": "annotate", "payload": {}}).status_code == 200
        assert _contexts(none)[0].tenant is None

    def test_a_tenant_mismatch_403_does_not_consume_a_rate_limit_token(
        self, tmp_path: Path
    ) -> None:
        limiter = _StubLimiter()
        harness = build_harness(tmp_path, rate_limiter=limiter, tenant=_header_tenant)
        token = harness.issue([Scope(kind="write", ref="annotate")], tenant="acme")
        res = _act(
            harness, token, {"action": "annotate", "payload": {}}, {"x-kohaku-tenant": "globex"}
        )
        assert res.status_code == 403
        assert limiter.calls == []

    def test_a_429_runs_neither_the_action_gate_nor_domain_invoke(self, tmp_path: Path) -> None:
        approvals = _Approvals429()
        limiter = _StubLimiter(RateLimitResult(allow=False, retryAfterMs=1000))
        harness = build_harness(tmp_path, rate_limiter=limiter, approvals=approvals)
        token = harness.issue([Scope(kind="write", ref="annotate")], tenant="acme")
        res = _act(harness, token, {"action": "annotate", "payload": {}, "approval": "tok"})
        assert res.status_code == 429
        assert approvals.verify_calls == 0
        assert _contexts(harness) == []


class _Approvals429:
    def __init__(self) -> None:
        self.verify_calls = 0

    async def issue_approval(self, **kwargs: Any) -> str:
        raise AssertionError("not used")

    async def verify_approval(self, token: str, **kwargs: Any) -> Any:
        self.verify_calls += 1
        raise AssertionError("the gate must not run behind a 429")
