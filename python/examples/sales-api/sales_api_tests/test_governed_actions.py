"""E2E tests for the demo's governed actions (design.md #62/#63): annotate (tier "confirm", paramsSchema)
and publish (tier "approve"). Mirrors TS apps/sample-api/test/api.e2e.test.ts's "governed actions" cases.
"""

from __future__ import annotations

import asyncio

from fastapi.testclient import TestClient

from kohaku.spec import JsonObject, Principal, Scope, action_payload_hash
from kohaku.storage import MemoryStoragePort
from sales_api.app import create_app
from sales_api.approval_port import create_hmac_approval_port
from sales_api.authz_port import create_hmac_authz_port
from sales_api.fake_llm import create_deterministic_fake_llm

_SECRET = "test-secret"


def _client() -> TestClient:
    storage = MemoryStoragePort()
    authz = create_hmac_authz_port(_SECRET)
    approvals = create_hmac_approval_port(_SECRET)
    llm = create_deterministic_fake_llm()
    app = asyncio.run(create_app(llm=llm, storage=storage, authz=authz, approvals=approvals))
    return TestClient(app.app)


def _issue_capability(scope_ref: str) -> str:
    authz = create_hmac_authz_port(_SECRET)
    return asyncio.run(
        authz.issue_capability(
            Principal(id="demo-user", roles=["user"]), [Scope(kind="write", ref=scope_ref)]
        )
    )


class TestAnnotateGovernance:
    def test_rejects_without_confirmed_then_succeeds_with_it(self) -> None:
        client = _client()
        cap = _issue_capability("annotate")

        no_confirm = client.post(
            "/api/kohaku/binding/action",
            headers={"authorization": f"Bearer {cap}"},
            json={"action": "annotate", "payload": {"note": "test note"}},
        )
        assert no_confirm.status_code == 403
        body = no_confirm.json()
        assert body["error"]["code"] == "APPROVAL_REQUIRED"
        assert body["error"]["approval"]["action"] == "annotate"
        assert body["error"]["approval"]["tier"] == "confirm"

        confirmed = client.post(
            "/api/kohaku/binding/action",
            headers={"authorization": f"Bearer {cap}"},
            json={"action": "annotate", "payload": {"note": "test note"}, "confirmed": True},
        )
        assert confirmed.status_code == 200

    def test_rejects_a_note_over_500_characters_before_invoking(self) -> None:
        client = _client()
        cap = _issue_capability("annotate")

        res = client.post(
            "/api/kohaku/binding/action",
            headers={"authorization": f"Bearer {cap}"},
            json={"action": "annotate", "payload": {"note": "x" * 501}, "confirmed": True},
        )
        assert res.status_code == 422
        body = res.json()
        assert body["error"]["code"] == "ACTION_PARAMS_INVALID"
        assert body["error"]["issues"] == [
            {"path": "note", "code": "maxLength", "message": "expected at most 500 characters"}
        ]


class TestPublishGovernance:
    def test_requires_a_bound_approval_token_issued_to_a_different_principal(self) -> None:
        client = _client()
        requester_cap = _issue_capability("publish")
        payload: JsonObject = {"action": "publish"}
        payload_hash = action_payload_hash(payload)

        no_approval = client.post(
            "/api/kohaku/binding/action",
            headers={"authorization": f"Bearer {requester_cap}"},
            json={"action": "publish", "payload": payload},
        )
        assert no_approval.status_code == 403
        body = no_approval.json()
        assert body["error"]["code"] == "APPROVAL_REQUIRED"
        assert body["error"]["approval"]["action"] == "publish"
        assert body["error"]["approval"]["tier"] == "approve"

        # The default header identity resolves no x-kohaku-role header to "admin" (id "demo-admin"),
        # distinct from the "demo-user" requester above, and the demo's governance RBAC grants admin
        # every operation kind (including action.approve) -- see app.py's _GOVERNANCE_POLICY.
        approve_res = client.post(
            "/api/kohaku/approvals",
            json={"action": "publish", "payloadHash": payload_hash, "requesterId": "demo-user"},
        )
        assert approve_res.status_code == 200
        approval = approve_res.json()["approval"]
        assert approval.startswith("kohaku-approval.v2.")

        approved = client.post(
            "/api/kohaku/binding/action",
            headers={"authorization": f"Bearer {requester_cap}"},
            json={"action": "publish", "payload": payload, "approval": approval},
        )
        assert approved.status_code == 200
        approved_body = approved.json()
        assert approved_body["result"]["ok"] is True
        assert approved_body["result"]["published"] == 1

        # This demo wires no ApprovalStore (single-use enforcement is optional per design.md #63), so the
        # same token verifies again for a second invoke of the identical (action, payload, requester)
        # triple -- a product that wants single-use tokens configures an ApprovalStore of its own.
        replay = client.post(
            "/api/kohaku/binding/action",
            headers={"authorization": f"Bearer {requester_cap}"},
            json={"action": "publish", "payload": payload, "approval": approval},
        )
        assert replay.status_code == 200

    def test_rejects_a_payload_with_an_extra_key_before_the_approval_gate(self) -> None:
        # publish's paramsSchema is closed: the payload is exactly {"action": "publish"}, so an approval
        # can never be requested (or minted) for an arbitrary payload.
        client = _client()
        cap = _issue_capability("publish")

        res = client.post(
            "/api/kohaku/binding/action",
            headers={"authorization": f"Bearer {cap}"},
            json={"action": "publish", "payload": {"action": "publish", "extra": 1}},
        )
        assert res.status_code == 422
        body = res.json()
        assert body["error"]["code"] == "ACTION_PARAMS_INVALID"
        assert body["error"]["issues"] == [
            {"path": "extra", "code": "additionalProperties", "message": 'unexpected property "extra"'}
        ]
