"""End to end: an upstream MCP server -> kohaku.domain_mcp -> host_rest (port of e2e.test.ts).

The upstream is a real in-process MCP server (the official SDK's `MCPServer`) reached through the SDK's `Client`;
kohaku's REST host is driven through httpx's ASGI transport so that everything shares one event loop. The LLM is
FakeLlm, and the approval port is a minimal in-test one (the HMAC approval port is a TS-only reference
implementation for now).
"""

from __future__ import annotations

import asyncio
import itertools
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import FastAPI
from mcp import Client
from mcp.server import MCPServer
from mcp_types import ToolAnnotations
from pydantic import BaseModel
from starlette.requests import Request

from kohaku.composer import ComposeContext
from kohaku.data_binding import parse_query_ref
from kohaku.domain_mcp import McpDomainPort, create_mcp_domain_port, create_mcp_intents
from kohaku.host_rest import KohakuHostDeps, attach_kohaku_routes
from kohaku.intents import IntentDef
from kohaku.lineage import (
    create_action_audit_recorder,
    create_lineage,
    create_view_recorder,
)
from kohaku.llm import FakeLlm
from kohaku.registry import core_catalog, resolve_catalog
from kohaku.spec import (
    ActionTier,
    ApprovalGrant,
    ApprovalVerifyResult,
    DataShape,
    GuiAction,
    Intent,
    IntentInput,
    JsonValue,
    LineageFilter,
    Principal,
    QueryHandle,
    Scope,
    SemanticInput,
    SessionContext,
    action_payload_hash,
)
from kohaku.storage import FileStoragePort

from ..host_rest.conftest import FakeAuthz

PREFIX = "/api/kohaku"
SOURCE = "orders"
OPEN_REF = "query://orders/list_orders?status=open"
ORDERS: list[dict[str, Any]] = [
    {"id": "o-1", "status": "open", "total": 10, "placedAt": "2026-04-01"},
    {"id": "o-2", "status": "paid", "total": 20, "placedAt": "2026-04-02"},
    {"id": "o-3", "status": "open", "total": 30, "placedAt": "2026-04-03"},
]


class Order(BaseModel):
    id: str
    status: str
    total: float
    placedAt: str


class OrdersResult(BaseModel):
    rows: list[Order]


def build_upstream(refunds: list[dict[str, Any]]) -> MCPServer:
    """The "existing MCP server": one read-only tool and one write tool, nothing kohaku-specific about it."""
    server = MCPServer("orders-upstream")

    @server.tool(annotations=ToolAnnotations(read_only_hint=True))
    def list_orders(status: Literal["open", "paid"] = "open", limit: int = 100) -> OrdersResult:
        """List orders, optionally by status"""
        rows = [Order(**o) for o in ORDERS if o["status"] == status][:limit]
        return OrdersResult(rows=rows)

    @server.tool(annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True))
    def refund_order(orderId: str, amount: float = 0) -> dict[str, Any]:
        """Refund an order"""
        refunds.append({"orderId": orderId, "amount": amount})
        return {"refunded": True, "orderId": orderId}

    return server


def orders_draft() -> dict[str, Any]:
    """The raw-format L1 draft FakeLlm hands the composer: a heading and a chart bound to the open-orders ref."""
    return {
        "components": [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["h", "c"]},
            {"id": "h", "type": "text.heading", "props": {"level": 2, "text": "Open orders"}},
            {
                "id": "c",
                "type": "presentChart",
                "props": {"kind": "bar", "x": "id", "y": "total"},
                "data": {"$ref": OPEN_REF},
            },
        ],
        "events": [],
    }


class McpSemantic:
    """A deterministic SemanticPort over the Intents `create_mcp_intents` made (GUI input only)."""

    def __init__(self, port: McpDomainPort, intents: list[IntentDef]) -> None:
        self._port = port
        self._intents = {intent.name: intent for intent in intents}

    async def normalize(self, input: SemanticInput, ctx: SessionContext) -> IntentInput:
        assert isinstance(input, GuiAction)
        name = str(input.params["intent"])
        facets = {k: v for k, v in input.params.items() if k != "intent"}
        return IntentInput(canonical=name, params=self._intents[name].params.parse(facets))

    async def resolve_query(
        self, intent: Intent, *, tenant: str | None = None
    ) -> QueryHandle | list[QueryHandle]:
        return self._intents[intent.canonical].to_queries(intent.params)

    async def data_version(self, handle: QueryHandle) -> str:
        return self._port.data_version()

    async def describe_shape(self, handle: QueryHandle) -> DataShape | None:
        return self._port.describe_shape(parse_query_ref(handle.uri))


class InMemoryApprovals:
    """Single-use approval tokens bound to (action, payload hash, requester)."""

    def __init__(self) -> None:
        self._grants: dict[str, ApprovalGrant] = {}
        self._counter = itertools.count(1)

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
        token = f"approval-{next(self._counter)}"
        self._grants[token] = ApprovalGrant(
            action=action,
            payloadHash=payload_hash,
            approverId=approver_id,
            requesterId=requester_id,
            exp=9999999999,
            jti=token,
        )
        return token

    async def verify_approval(
        self,
        token: str,
        *,
        action: str,
        payload_hash: str,
        requester_id: str,
        tenant: str | None = None,
    ) -> ApprovalVerifyResult:
        grant = self._grants.get(token)
        if grant is None:
            return ApprovalVerifyResult(ok=False, reason="unknown approval")
        if (grant.action, grant.payloadHash, grant.requesterId) != (
            action,
            payload_hash,
            requester_id,
        ):
            return ApprovalVerifyResult(ok=False, reason="approval is bound to another request")
        del self._grants[token]
        return ApprovalVerifyResult(ok=True, grant=grant)


def _auth(request: Request) -> Principal:
    return Principal(id=request.headers.get("x-user", "anonymous"), roles=[])


def _authorize(principal: Principal, operation: Any, tenant: str | None) -> bool:
    return bool(operation.kind == "action.approve" and principal.id == "approver")


async def _run(tmp_path: Path, scenario: Any) -> None:
    refunds: list[dict[str, Any]] = []
    upstream = build_upstream(refunds)
    async with Client(upstream) as client:
        port = await create_mcp_domain_port(client=client)
        intents = create_mcp_intents(port, source=SOURCE)
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage)
        authz = FakeAuthz()
        ctx = ComposeContext(
            catalog=resolve_catalog(core_catalog()),
            semantic=McpSemantic(port, intents),
            storage=storage,
            llm=FakeLlm(objects=lambda _req: orders_draft()),
        )
        deps = KohakuHostDeps(
            compose=ctx,
            domain=port,
            authz=authz,
            query_source=SOURCE,
            recorder=create_view_recorder(lineage),
            auth=_auth,
            authorize_governance=_authorize,
            approvals=InMemoryApprovals(),
            action_audit_recorder=create_action_audit_recorder(lineage),
        )
        app = FastAPI()
        attach_kohaku_routes(app, deps)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://kohaku.test") as http:
            await scenario(http, port, authz, lineage, refunds)


def _run_sync(tmp_path: Path, scenario: Any) -> None:
    asyncio.run(_run(tmp_path, scenario))


def test_exposes_the_read_only_tool_as_an_intent_and_the_write_tool_as_an_approve_tier_action(
    tmp_path: Path,
) -> None:
    async def scenario(
        http: Any, port: McpDomainPort, authz: Any, lineage: Any, refunds: Any
    ) -> None:
        assert list(port.query_ops) == ["list_orders"]
        assert list(port.action_ops) == ["refund_order"]
        ops = {op.name: op for op in await port.list_operations()}
        tier: ActionTier | None = ops["refund_order"].tier
        assert tier == "approve"
        schema = ops["refund_order"].paramsSchema
        assert schema["type"] == "object"
        assert schema["required"] == ["orderId"]
        assert schema["additionalProperties"] is False
        assert set(schema["properties"]) == {"orderId", "amount"}

    _run_sync(tmp_path, scenario)


def test_composes_a_view_over_the_read_tool_and_resolves_its_rows(tmp_path: Path) -> None:
    async def scenario(
        http: Any, port: McpDomainPort, authz: Any, lineage: Any, refunds: Any
    ) -> None:
        res = await http.post(
            f"{PREFIX}/compose",
            json={
                "input": {
                    "kind": "gui",
                    "action": "view.select",
                    "params": {"intent": "orders.list_orders", "status": "open"},
                }
            },
        )
        assert res.status_code == 200, res.text
        body = res.json()
        spec = body["spec"]
        assert spec["provenance"]["tier"] == "L1"
        assert spec["dataVersion"].startswith("mcp:")
        chart = next(c for c in spec["components"] if c["type"] == "presentChart")
        assert chart["data"]["$ref"] == OPEN_REF

        data_res = await http.get(
            f"{PREFIX}/binding/resolve",
            params={"ref": OPEN_REF},
            headers={"authorization": f"Bearer {body['capability']}"},
        )
        assert data_res.status_code == 200, data_res.text
        data = data_res.json()
        assert [r["id"] for r in data["rows"]] == ["o-1", "o-3"]
        assert [c["key"] for c in data["columns"]] == ["id", "status", "total", "placedAt"]
        assert data["dataVersion"] == spec["dataVersion"]

    _run_sync(tmp_path, scenario)


def test_gates_the_write_tool_behind_an_approval_token_and_records_the_trail(
    tmp_path: Path,
) -> None:
    async def scenario(
        http: Any, port: McpDomainPort, authz: Any, lineage: Any, refunds: Any
    ) -> None:
        requester_cap = await authz.issue_capability(
            Principal(id="requester", roles=[]), [Scope(kind="write", ref="refund_order")]
        )
        payload: dict[str, JsonValue] = {"orderId": "o-1", "amount": 5}

        async def attempt(approval: str | None = None, body_payload: Any = None) -> Any:
            body: dict[str, Any] = {
                "action": "refund_order",
                "payload": payload if body_payload is None else body_payload,
            }
            if approval is not None:
                body["approval"] = approval
            return await http.post(
                f"{PREFIX}/binding/action",
                json=body,
                headers={"authorization": f"Bearer {requester_cap}"},
            )

        refused = await attempt()
        assert refused.status_code == 403
        error = refused.json()["error"]
        assert error["code"] == "APPROVAL_REQUIRED"
        assert error["approval"]["tier"] == "approve"
        assert refunds == []

        # A payload the projected schema forbids is refused before the approval gate (422).
        invalid = await attempt(body_payload={"orderId": "o-1", "extra": True})
        assert invalid.status_code == 422
        assert refunds == []

        approve = await http.post(
            f"{PREFIX}/approvals",
            json={
                "action": "refund_order",
                "payloadHash": action_payload_hash(payload),
                "requesterId": "requester",
            },
            headers={"x-user": "approver"},
        )
        assert approve.status_code == 200, approve.text
        approval = approve.json()["approval"]

        approved = await attempt(approval)
        assert approved.status_code == 200, approved.text
        assert approved.json()["result"] == {"refunded": True, "orderId": "o-1"}
        assert refunds == [{"orderId": "o-1", "amount": 5}]

        requested = await lineage.list_events(LineageFilter(type=["action.approvalRequested"]))
        approved_events = await lineage.list_events(LineageFilter(type=["action.approved"]))
        assert len(requested) == 1
        assert len(approved_events) == 1

    _run_sync(tmp_path, scenario)


def test_never_lets_a_write_tool_be_read(tmp_path: Path) -> None:
    async def scenario(
        http: Any, port: McpDomainPort, authz: Any, lineage: Any, refunds: Any
    ) -> None:
        composed = await http.post(
            f"{PREFIX}/compose",
            json={
                "input": {
                    "kind": "gui",
                    "action": "view.select",
                    "params": {"intent": "orders.list_orders"},
                }
            },
        )
        capability = composed.json()["capability"]
        res = await http.get(
            f"{PREFIX}/binding/resolve",
            params={"ref": "query://orders/refund_order?orderId=o-1"},
            headers={"authorization": f"Bearer {capability}"},
        )
        assert res.status_code == 403
        assert refunds == []

    _run_sync(tmp_path, scenario)
