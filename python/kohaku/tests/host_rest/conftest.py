"""Shared harness for host_rest tests (FastAPI TestClient + FakeLlm + in-memory Ports).

Assembles the minimal stack to pytest-ify the black-box checks of conformance rest-host.ts ahead of time.
The LLM is FakeLlm (scripted responses); a real LLM is not called.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from kohaku.composer import ComposeContext
from kohaku.host_rest import (
    KohakuHostDeps,
    attach_kohaku_routes,
)
from kohaku.host_rest.deps import (
    ActionEffectsHook,
    AuthHook,
    AuthorizeGovernanceHook,
    OnErrorHook,
    TenantHook,
)
from kohaku.lineage import (
    create_fixations,
    create_lineage,
    create_promotions,
    create_view_recorder,
    summarize_lineage,
)
from kohaku.llm import FakeLlm
from kohaku.registry import core_catalog, resolve_catalog
from kohaku.spec import (
    DataShape,
    Intent,
    IntentInput,
    InvocationContext,
    JsonObject,
    OperationDescriptor,
    Principal,
    QueryHandle,
    Scope,
    SemanticInput,
    SessionContext,
    TabularData,
    VerifyRequest,
    VerifyResult,
)
from kohaku.storage import FileStoragePort

PREFIX = "/api/kohaku"
REF = "query://sales/summary?fy=2026"
INTENT_BODY: dict[str, Any] = {"canonical": "sales.summary", "params": {"fy": 2026}}


def _l1_draft() -> dict[str, Any]:
    """A generation-schema-conformant L1 draft (with an event declaration — for REST-EVT-001)."""
    return {
        "components": [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["h", "t"]},
            {"id": "h", "type": "text.heading", "props": {"level": 2, "text": "Sales summary"}},
            {"id": "t", "type": "presentSpreadsheet", "props": {}, "data": {"$ref": REF}},
        ],
        "events": [
            {
                "on": "t.rowClick",
                "emit": "intent.patch",
                "payload": [{"key": "region", "value": "$row.region"}],
            }
        ],
    }


class FakeSemantic:
    """Deterministic SemanticPort. normalize always returns the same Intent (cache consistency)."""

    async def normalize(self, input: SemanticInput, ctx: SessionContext) -> IntentInput:
        return IntentInput(canonical="sales.summary", params={"fy": 2026})

    async def resolve_query(
        self, intent: Intent, *, tenant: str | None = None
    ) -> QueryHandle | list[QueryHandle]:
        return QueryHandle(uri=REF)

    async def data_version(self, handle: QueryHandle) -> str:
        return "v1"

    async def describe_shape(self, handle: QueryHandle) -> DataShape | None:
        return DataShape.model_validate(
            {
                "columns": [
                    {"name": "region", "type": "string", "role": "dimension"},
                    {"name": "revenue", "type": "number", "role": "measure"},
                ]
            }
        )


class FakeDomain:
    """Reference resolution returns a tabular envelope; writes return an echo result."""

    def __init__(self) -> None:
        self.invocations: list[tuple[str, JsonObject]] = []

    async def list_operations(self) -> list[OperationDescriptor]:
        return [
            OperationDescriptor(name="annotate", description="write"),
            OperationDescriptor(name="summary", description="read"),
        ]

    async def invoke(self, op: str, args: JsonObject, ctx: InvocationContext) -> object:
        self.invocations.append((op, args))
        if op == "summary":
            return TabularData.model_validate(
                {
                    "columns": [
                        {"key": "region", "type": "string"},
                        {"key": "revenue", "type": "number"},
                    ],
                    "rows": [{"region": "us", "revenue": 100}],
                    "dataVersion": "v1",
                }
            )
        if op == "boom":
            raise RuntimeError("transient domain-downstream failure")
        # A write (action) echoes back.
        return {"ok": True, "op": op, "args": args}


class FakeAuthz:
    """In-memory capability. Scopes are matched by exact kind + ref."""

    def __init__(self) -> None:
        self._tokens: dict[str, tuple[Principal, list[Scope]]] = {}
        self._n = 0

    async def issue_capability(
        self, principal: Principal, scopes: list[Scope], *, ttl_seconds: int | None = None
    ) -> str:
        self._n += 1
        token = f"cap-{self._n}"
        self._tokens[token] = (principal, list(scopes))
        return token

    async def verify(self, token: str, req: VerifyRequest) -> VerifyResult:
        entry = self._tokens.get(token)
        if entry is None:
            return VerifyResult(ok=False, reason="unknown capability")
        principal, scopes = entry
        for s in scopes:
            if s.kind == req.kind and s.ref == req.ref:
                return VerifyResult(ok=True, principal=principal)
        return VerifyResult(ok=False, reason="scope not granted")


@dataclass
class Harness:
    client: TestClient
    deps: KohakuHostDeps
    ctx: ComposeContext
    domain: FakeDomain
    authz: FakeAuthz
    storage: FileStoragePort
    ref: str = REF
    intent_body: dict[str, Any] = field(default_factory=lambda: dict(INTENT_BODY))

    def issue(self, scopes: list[Scope]) -> str:
        """Issue a capability directly for tests (used to check write paths like binding/action)."""
        return asyncio.run(
            self.authz.issue_capability(Principal(id="tester", roles=["user"]), scopes)
        )


def build_harness(
    tmp_path: Path,
    *,
    with_promotions: bool = True,
    with_fixations: bool = True,
    with_analytics: bool = True,
    with_recorder: bool = True,
    authorize_governance: AuthorizeGovernanceHook | None = None,
    on_error: OnErrorHook | None = None,
    tenant: TenantHook | None = None,
    auth: AuthHook | None = None,
    action_effects: ActionEffectsHook | None = None,
) -> Harness:
    storage = FileStoragePort(tmp_path)
    catalog = resolve_catalog(core_catalog())
    ctx = ComposeContext(
        catalog=catalog,
        semantic=FakeSemantic(),
        storage=storage,
        llm=FakeLlm(objects=lambda _req: _l1_draft()),
    )
    lineage = create_lineage(storage)
    domain = FakeDomain()
    authz = FakeAuthz()
    deps = KohakuHostDeps(
        compose=ctx,
        domain=domain,
        authz=authz,
        query_source="sales",
        recorder=create_view_recorder(lineage) if with_recorder else None,
        promotions=create_promotions(lineage=lineage, storage=storage)
        if with_promotions
        else None,
        fixations=create_fixations(
            lineage=lineage, storage=storage, catalog_for=lambda _t: catalog
        )
        if with_fixations
        else None,
        analytics_summarizer=summarize_lineage if with_analytics else None,
        fixation_lookup=lambda h, session: storage.get_fixation(h, session.tenant),
        authorize_governance=authorize_governance,
        on_error=on_error,
        tenant=tenant,
        auth=auth,
        action_effects=action_effects,
    )
    app = FastAPI()
    attach_kohaku_routes(app, deps)
    client = TestClient(app)
    return Harness(
        client=client, deps=deps, ctx=ctx, domain=domain, authz=authz, storage=storage
    )


@pytest.fixture()
def harness(tmp_path: Path) -> Harness:
    return build_harness(tmp_path)


@pytest.fixture()
def client(harness: Harness) -> TestClient:
    return harness.client


def role_auth(role: str) -> Callable[[Request], Principal]:
    """An auth hook (for tests) that mimics an x-kohaku-role header."""

    def _auth(_request: Request) -> Principal:
        return Principal(id=f"demo-{role}", roles=[role])

    return _auth
