"""E2E for the sample with ``KOHAKU_AUTHZ=jwt`` wiring (port of TS apps/sample-api/test/jwt-identity.e2e.test.ts),
plus the env-selection cases of ``authz_from_env`` (TS: the jwt branch of ports/from-env.ts).

The app is built with the JWT AuthzPort and ``create_jwt_request_identity``: principal / roles / tenant come
from the verified bearer token, never from headers; the data plane (``/binding/*``) keeps the HMAC capability.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import jwt
import pytest
from fastapi.testclient import TestClient

from kohaku.authz_hmac import create_hmac_approval_port, create_memory_approval_store
from kohaku.authz_jwt import JwtSecretKey, create_jwt_authz_port
from kohaku.spec import (
    JsonObject,
    KohakuPolicyFile,
    LineageFilter,
    PolicyRateLimitRule,
    PolicyRateLimits,
    PolicySection,
    Principal,
    Scope,
    VerifyRequest,
    action_payload_hash,
)
from kohaku.storage import MemoryStoragePort
from sales_api.app import SalesApp, create_app
from sales_api.authz_from_env import (
    DEFAULT_CAPABILITY_SECRET,
    capability_secret_from_env,
    create_authz_from_env,
)
from sales_api.fake_llm import create_deterministic_fake_llm
from sales_api.request_identity_jwt import create_jwt_request_identity

SECRET = "test-secret-at-least-32-bytes-long-000"


def _jwt(**claims: Any) -> str:
    return jwt.encode({**claims, "exp": int(time.time()) + 300}, SECRET, algorithm="HS256")


def _bearer(token: str) -> dict[str, str]:
    return {"authorization": f"Bearer {token}"}


def _make_app(
    *,
    demo_admin_routes: bool | None = None,
    approvals: bool = False,
    policy_file: KohakuPolicyFile | None = None,
    require_capability_tenant: bool = False,
) -> tuple[TestClient, MemoryStoragePort, SalesApp]:
    authz = create_jwt_authz_port(
        JwtSecretKey(SECRET),
        capability_secret="cap",
        require_capability_tenant=require_capability_tenant,
    )
    storage = MemoryStoragePort()
    sales = asyncio.run(
        create_app(
            llm=create_deterministic_fake_llm(),
            storage=storage,
            authz=authz,
            identity=create_jwt_request_identity(authz.identity),
            demo_admin_routes=demo_admin_routes,
            approvals=(
                create_hmac_approval_port("cap", store=create_memory_approval_store())
                if approvals
                else None
            ),
            policy_file=policy_file,
        )
    )
    return TestClient(sales.app), storage, sales


QUARTERLY_GUI: dict[str, Any] = {
    "input": {
        "kind": "gui",
        "action": "view.select",
        "params": {
            "intent": "sales.quarterly_summary",
            "fiscalYear": 2026,
            "quarter": 3,
            "groupBy": "region",
        },
    }
}

RECORDS_GUI: dict[str, Any] = {
    "input": {"kind": "gui", "action": "view.select", "params": {"intent": "sales.records"}}
}


def _composed_lineage(storage: MemoryStoragePort) -> list[Any]:
    return asyncio.run(storage.list_lineage(LineageFilter(type=["view.composed"])))


class TestSampleWithJwtAuthzWiring:
    def test_rejects_a_request_without_a_bearer_token_with_401_and_the_error_envelope(self) -> None:
        client, _, _ = _make_app()
        res = client.get("/api/kohaku/catalog")
        assert res.status_code == 401
        assert res.json()["error"]["code"] == "CAPABILITY_DENIED"

    def test_rejects_an_invalid_token_with_401_and_says_why(self) -> None:
        client, _, _ = _make_app()
        res = client.get("/api/kohaku/catalog", headers=_bearer("not-a-jwt"))
        assert res.status_code == 401
        assert "INVALID_TOKEN" in res.json()["error"]["message"]

    def test_derives_roles_from_the_token_a_viewer_cannot_approve_an_admin_can_list_promotions(
        self,
    ) -> None:
        client, _, _ = _make_app()
        viewer = _jwt(sub="v", roles=["viewer"])
        admin = _jwt(sub="a", roles=["admin"])

        def evaluate(token: str) -> int:
            return client.post(
                "/api/kohaku/promotions/evaluate", headers=_bearer(token)
            ).status_code

        assert evaluate(viewer) == 403
        assert evaluate(admin) == 200

    def test_derives_the_tenant_from_the_token_and_ignores_x_kohaku_tenant(self) -> None:
        client, storage, _ = _make_app()
        token = _jwt(sub="u", roles=["admin"], tenant="acme")
        res = client.post(
            "/api/kohaku/compose",
            headers={**_bearer(token), "x-kohaku-tenant": "spoofed"},
            json=QUARTERLY_GUI,
        )
        assert res.status_code == 200
        assert _composed_lineage(storage)[0].tenant == "acme"

    def test_has_no_tenant_when_the_token_carries_none_even_with_x_kohaku_tenant_present(
        self,
    ) -> None:
        client, storage, _ = _make_app()
        token = _jwt(sub="u", roles=["admin"])
        res = client.post(
            "/api/kohaku/compose",
            headers={**_bearer(token), "x-kohaku-tenant": "spoofed"},
            json=QUARTERLY_GUI,
        )
        assert res.status_code == 200
        assert _composed_lineage(storage)[0].tenant is None

    def test_keeps_the_data_plane_alive_the_hmac_capability_from_compose_resolves_binding_resolve(
        self,
    ) -> None:
        client, _, _ = _make_app()
        token = _jwt(sub="u", roles=["admin"])
        composed = client.post("/api/kohaku/compose", headers=_bearer(token), json=QUARTERLY_GUI)
        assert composed.status_code == 200
        body = composed.json()
        ref = next(c["data"]["$ref"] for c in body["spec"]["components"] if c.get("data"))
        resolve_url = "/api/kohaku/binding/resolve"

        # The data-binding client sends the capability (an HMAC token, not a JWS) in the Authorization header.
        ok = client.get(resolve_url, params={"ref": ref}, headers=_bearer(body["capability"]))
        assert ok.status_code == 200

        # The route stays fail-closed: no Authorization at all is rejected by host_rest's own capability check.
        assert client.get(resolve_url, params={"ref": ref}).status_code == 401

        # A bearer that is neither a valid capability nor anything else the data plane accepts is still denied.
        bogus = client.get(resolve_url, params={"ref": ref}, headers=_bearer(token))
        assert 401 <= bogus.status_code < 500

    def test_does_not_run_the_identity_middleware_on_the_data_plane_but_does_on_every_other_route(
        self,
    ) -> None:
        # /binding/* is the only exemption: a garbage bearer reaches host_rest there (its own capability verdict
        # carries the standard envelope), whereas every other /api/kohaku route stops in the
        # identity middleware first.
        client, _, _ = _make_app()
        for path in (
            "/api/kohaku/catalog",
            "/api/kohaku/lineage/events",
            "/api/kohaku/analytics/summary",
        ):
            res = client.get(path, headers=_bearer("garbage"))
            assert res.status_code == 401
            assert "authentication required (INVALID_TOKEN)" in res.json()["error"]["message"]
        data_plane = client.get(
            "/api/kohaku/binding/resolve",
            params={"ref": "query://sales/x"},
            headers=_bearer("garbage"),
        )
        assert (
            data_plane.status_code == 403
        )  # host_rest's own capability verdict, not the middleware's 401
        assert "authentication required" not in data_plane.json()["error"]["message"]


class TestDemoOnlyBumpDataVersionRoute:
    """Opt-in under JWT: the route changes the data version (a free LLM-spend lever), so it is off by default."""

    def test_is_not_registered_by_default_even_for_an_admin_token(self) -> None:
        client, _, _ = _make_app()
        admin = _jwt(sub="a", roles=["admin"])
        for path in ("/api/kohaku/admin/bump-data-version", "/api/admin/bump-data-version"):
            assert client.post(path, headers=_bearer(admin)).status_code == 404

    def test_with_demo_admin_routes_true_requires_a_bearer_token_401_and_then_honors_admin_rbac(
        self,
    ) -> None:
        client, _, _ = _make_app(demo_admin_routes=True)
        path = "/api/kohaku/admin/bump-data-version"

        no_token = client.post(path)
        assert no_token.status_code == 401
        assert no_token.json()["error"]["code"] == "CAPABILITY_DENIED"

        viewer = client.post(path, headers=_bearer(_jwt(sub="v", roles=["viewer"])))
        assert viewer.status_code == 403

        admin = client.post(path, headers=_bearer(_jwt(sub="a", roles=["admin"])))
        assert admin.status_code == 200
        assert isinstance(admin.json()["dataVersion"], str)

    def test_the_legacy_unauthenticated_path_is_never_registered_under_a_jwt_identity(self) -> None:
        client, _, _ = _make_app(demo_admin_routes=True)
        assert client.post("/api/admin/bump-data-version").status_code == 404


class TestDataPlaneUnderJwtCapabilityCarriesTheTenant:
    """SPEC CAP-TEN-002: tenant, principal and rate-limit key come from the signed capability."""

    def _compose_as(self, client: TestClient, token: str) -> dict[str, Any]:
        res = client.post("/api/kohaku/compose", headers=_bearer(token), json=RECORDS_GUI)
        assert res.status_code == 200
        body: dict[str, Any] = res.json()
        return body

    def test_an_approve_tier_action_runs_end_to_end_requester_composes_approver_approves(
        self,
    ) -> None:
        client, _, _ = _make_app(approvals=True)
        requester = _jwt(sub="req", roles=["viewer"], tenant="acme")
        approver = _jwt(sub="apr", roles=["approver"], tenant="acme")
        capability = self._compose_as(client, requester)["capability"]
        payload: JsonObject = {"action": "publish"}

        def invoke(approval: str | None = None) -> Any:
            body: dict[str, Any] = {"action": "publish", "payload": payload}
            if approval is not None:
                body["approval"] = approval
            return client.post("/api/kohaku/binding/action", headers=_bearer(capability), json=body)

        first = invoke()
        assert first.status_code == 403
        error = first.json()["error"]
        assert error["code"] == "APPROVAL_REQUIRED"
        assert error["approval"]["payloadHash"] == action_payload_hash(payload)

        minted = client.post(
            "/api/kohaku/approvals",
            headers=_bearer(approver),
            json={
                "action": "publish",
                "payloadHash": error["approval"]["payloadHash"],
                "requesterId": "req",
            },
        )
        assert minted.status_code == 200
        approved = invoke(minted.json()["approval"])
        assert approved.status_code == 200

    def test_an_approver_cannot_do_anything_else_with_the_governance_plane(self) -> None:
        client, _, _ = _make_app(approvals=True)
        approver = _jwt(sub="apr", roles=["approver"], tenant="acme")
        assert (
            client.post("/api/kohaku/promotions/evaluate", headers=_bearer(approver)).status_code
            == 403
        )

    def test_keys_the_binding_action_rate_limit_by_the_capabilitys_tenant_and_sub(self) -> None:
        policy_file = KohakuPolicyFile(
            version=1,
            defaults=PolicySection(),
            tenants={
                "acme": PolicySection(
                    rateLimits=PolicyRateLimits(
                        action=PolicyRateLimitRule(capacity=1, refillPerSecond=0.001)
                    )
                )
            },
        )
        client, _, _ = _make_app(approvals=True, policy_file=policy_file)
        first = self._compose_as(client, _jwt(sub="u1", roles=["viewer"], tenant="acme"))
        second = self._compose_as(client, _jwt(sub="u2", roles=["viewer"], tenant="acme"))

        def act(capability: str) -> int:
            return client.post(
                "/api/kohaku/binding/action",
                headers=_bearer(capability),
                json={"action": "publish", "payload": {"action": "publish"}},
            ).status_code

        assert act(first["capability"]) == 403  # APPROVAL_REQUIRED, but past the limiter
        assert act(first["capability"]) == 429  # u1's bucket (tenant acme, class action) is spent
        assert act(second["capability"]) == 403  # u2 has its own bucket

    def test_require_capability_tenant_a_compose_with_a_tenant_less_jwt_yields_a_capability_the_data_plane_refuses(
        self,
    ) -> None:
        client, _, _ = _make_app(require_capability_tenant=True)
        composed = self._compose_as(client, _jwt(sub="u", roles=["viewer"]))
        ref = next(c["data"]["$ref"] for c in composed["spec"]["components"] if c.get("data"))
        res = client.get(
            "/api/kohaku/binding/resolve",
            params={"ref": ref},
            headers=_bearer(composed["capability"]),
        )
        assert res.status_code == 403
        assert res.json()["error"]["code"] == "CAPABILITY_DENIED"

    def test_a_tenant_bearing_jwt_yields_a_tenant_bound_capability_the_data_plane_accepts_under_require_capability_tenant(
        self,
    ) -> None:
        client, _, _ = _make_app(require_capability_tenant=True)
        composed = self._compose_as(client, _jwt(sub="u", roles=["viewer"], tenant="acme"))
        ref = next(c["data"]["$ref"] for c in composed["spec"]["components"] if c.get("data"))
        res = client.get(
            "/api/kohaku/binding/resolve",
            params={"ref": ref},
            headers=_bearer(composed["capability"]),
        )
        assert res.status_code == 200


class TestAuthzFromEnv:
    """The env selection of the sample (TS: ports/from-env.ts buildAuthzFromEnv / capabilitySecretFromEnv)."""

    def test_defaults_to_hmac_with_no_identity(self) -> None:
        selected = create_authz_from_env({})
        assert selected.kind == "hmac"
        assert selected.identity is None
        assert selected.capability_secret == DEFAULT_CAPABILITY_SECRET

    def test_an_empty_or_whitespace_capability_secret_counts_as_unset(self) -> None:
        assert (
            capability_secret_from_env({"KOHAKU_CAPABILITY_SECRET": "  "})
            == DEFAULT_CAPABILITY_SECRET
        )
        assert (
            capability_secret_from_env({"KOHAKU_CAPABILITY_SECRET": ""})
            == DEFAULT_CAPABILITY_SECRET
        )
        # The value itself is returned untrimmed once it counts as set.
        assert capability_secret_from_env({"KOHAKU_CAPABILITY_SECRET": " s3cret "}) == " s3cret "

    def test_rejects_an_unknown_kind(self) -> None:
        with pytest.raises(ValueError, match="KOHAKU_AUTHZ must be hmac or jwt"):
            create_authz_from_env({"KOHAKU_AUTHZ": "saml"})

    def test_jwt_refuses_to_run_on_the_publicly_known_default_capability_secret(self) -> None:
        with pytest.raises(ValueError, match="KOHAKU_CAPABILITY_SECRET must be set"):
            create_authz_from_env({"KOHAKU_AUTHZ": "jwt", "KOHAKU_JWT_SECRET": SECRET})

    def test_jwt_requires_a_secret_or_a_jwks_url(self) -> None:
        with pytest.raises(ValueError, match="requires KOHAKU_JWT_SECRET or KOHAKU_JWT_JWKS_URL"):
            create_authz_from_env({"KOHAKU_AUTHZ": "jwt", "KOHAKU_CAPABILITY_SECRET": "real"})

    def test_jwt_with_a_jwks_url_requires_an_audience_named_in_env_terms(self) -> None:
        with pytest.raises(ValueError, match="KOHAKU_JWT_AUDIENCE"):
            create_authz_from_env(
                {
                    "KOHAKU_AUTHZ": "jwt",
                    "KOHAKU_CAPABILITY_SECRET": "real",
                    "KOHAKU_JWT_JWKS_URL": "https://issuer.example.com/jwks.json",
                }
            )

    def _jwt_env(self, **extra: str) -> dict[str, str]:
        return {
            "KOHAKU_AUTHZ": "jwt",
            "KOHAKU_CAPABILITY_SECRET": "real-capability-secret",
            "KOHAKU_JWT_SECRET": SECRET,
            **extra,
        }

    def test_jwt_builds_a_port_whose_identity_requires_a_tenant_by_default(self) -> None:
        selected = create_authz_from_env(self._jwt_env())
        assert selected.kind == "jwt" and selected.identity is not None
        # No tenant claim -> MISSING_TENANT (the sample defaults to requiring one whenever JWT is in play).
        with pytest.raises(Exception) as info:
            asyncio.run(selected.identity.resolve(_jwt(sub="u")))
        assert getattr(info.value, "code", None) == "MISSING_TENANT"
        resolved = asyncio.run(selected.identity.resolve(_jwt(sub="u", tenant="acme")))
        assert resolved.tenant == "acme"

    def test_require_tenant_zero_opts_out_of_tenant_bearing_tokens_and_of_the_capability_requirement(
        self,
    ) -> None:
        selected = create_authz_from_env(
            self._jwt_env(KOHAKU_JWT_REQUIRE_TENANT="0"), require_capability_tenant=True
        )
        assert selected.identity is not None
        assert asyncio.run(selected.identity.resolve(_jwt(sub="u"))).tenant is None
        # require_capability_tenant is subject to the opt-out: a tenant-less capability still verifies.

        cap = asyncio.run(
            selected.authz.issue_capability(Principal(id="u"), [Scope(kind="read", ref="r")])
        )
        assert asyncio.run(selected.authz.verify(cap, VerifyRequest(kind="read", ref="r"))).ok

    def test_require_capability_tenant_is_applied_when_tenant_bearing_tokens_are_required(
        self,
    ) -> None:

        selected = create_authz_from_env(self._jwt_env(), require_capability_tenant=True)
        cap = asyncio.run(
            selected.authz.issue_capability(Principal(id="u"), [Scope(kind="read", ref="r")])
        )
        verdict = asyncio.run(selected.authz.verify(cap, VerifyRequest(kind="read", ref="r")))
        assert verdict.ok is False and verdict.reason == "capability lacks tenant"

    def test_jwt_audience_and_issuer_come_from_env(self) -> None:
        selected = create_authz_from_env(
            self._jwt_env(KOHAKU_JWT_AUDIENCE="kohaku", KOHAKU_JWT_ISSUER="https://issuer.test")
        )
        assert selected.identity is not None
        good = jwt.encode(
            {
                "sub": "u",
                "tenant": "acme",
                "aud": "kohaku",
                "iss": "https://issuer.test",
                "exp": int(time.time()) + 300,
            },
            SECRET,
            algorithm="HS256",
        )
        assert asyncio.run(selected.identity.resolve(good)).principal.id == "u"
        with pytest.raises(Exception) as info:
            asyncio.run(selected.identity.resolve(_jwt(sub="u", tenant="acme")))  # no aud / iss
        assert getattr(info.value, "code", None) == "INVALID_TOKEN"

    def test_a_jwks_url_selects_the_remote_key_source(self) -> None:
        selected = create_authz_from_env(
            {
                "KOHAKU_AUTHZ": "jwt",
                "KOHAKU_CAPABILITY_SECRET": "real-capability-secret",
                "KOHAKU_JWT_JWKS_URL": "https://issuer.example.com/jwks.json",
                "KOHAKU_JWT_AUDIENCE": "kohaku",
            }
        )
        assert selected.kind == "jwt" and selected.identity is not None
