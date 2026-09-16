"""Shared building blocks for host_mcp tests (equivalent to makeComposeCtx in TS packages/host-mcp-apps/test).

Checks behavior from an in-process MCP client with FakeLlm (the LLM is not called on the fixedSpecs path) plus
deterministic SemanticPort / DomainPort / AuthzPort.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, cast

from mcp import Client
from mcp.server import Server
from mcp_types import RequestParamsMeta

from kohaku.composer import ComposeContext, ComposePolicy
from kohaku.host_mcp import AttachOptions, McpHostDeps, attach_kohaku_to_mcp_server
from kohaku.llm import FakeLlm
from kohaku.registry import core_catalog, resolve_catalog
from kohaku.spec import (
    GuiAction,
    Intent,
    IntentInput,
    QueryHandle,
    SessionContext,
    TabularData,
    UISpec,
    VerifyRequest,
    VerifyResult,
)

CATALOG = resolve_catalog(core_catalog())
TREND_REF = "query://sales/trend?granularity=month&metric=revenue"

DATA = TabularData.model_validate(
    {
        "columns": [{"key": "month", "type": "string"}, {"key": "revenue", "type": "number"}],
        "rows": [{"month": "2026-04", "revenue": 100}, {"month": "2026-05", "revenue": 200}],
        "dataVersion": "sales@seed-1",
    }
)


class SimpleAuthz:
    """Simple authz: token = "cap:" + permitted refs joined by "|". verify is prefix match (for tests)."""

    async def issue_capability(
        self, principal: Any, scopes: list[Any], *, ttl_seconds: int | None = None
    ) -> str:
        return "cap:" + "|".join(s.ref for s in scopes)

    async def verify(self, token: str, req: VerifyRequest) -> VerifyResult:
        ok = token.startswith("cap:") and any(
            req.ref.startswith(part) for part in token[4:].split("|")
        )
        return VerifyResult(ok=ok, principal=None, reason=None if ok else "scope")


class TrendDomain:
    """A domain that returns DATA only for op="trend" (equivalent to the domain in TS makeComposeCtx)."""

    async def list_operations(self) -> list[Any]:
        return []

    async def invoke(self, op: str, args: Any, ctx: Any) -> object:
        if op != "trend":
            raise ValueError("unknown op")
        return DATA


class _Semantic:
    """Deterministic SemanticPort. GUI input merges current + payload (same as TS makeComposeCtx)."""

    def __init__(self, canonical: str = "sales.trend", ref: str = TREND_REF) -> None:
        self._canonical = canonical
        self._ref = ref

    async def normalize(self, input: Any, ctx: SessionContext) -> IntentInput:
        if isinstance(input, GuiAction):
            base = dict(input.current.params) if input.current is not None else {}
            base.update(input.params)
            return IntentInput(canonical=self._canonical, params=base)
        return IntentInput(canonical=self._canonical, params={})

    async def resolve_query(
        self, intent: Intent, *, tenant: str | None = None
    ) -> QueryHandle:
        return QueryHandle(uri=self._ref)

    async def data_version(self, handle: QueryHandle) -> str:
        return "sales@seed-1"

    async def describe_shape(self, handle: QueryHandle) -> None:
        return None


def _fixed_source(build: Any) -> Any:
    """Build a FixedSpecSource that returns build(intent, handles) -> UISpec."""

    class _Fixed:
        async def lookup(self, intent: Intent) -> Any:
            return build

    return _Fixed()


def trend_spec_builder(intent_arg: Intent, handles: list[QueryHandle]) -> UISpec:
    """A single-ref trend fixed Spec (the fixedSpecs of TS makeComposeCtx)."""
    return UISpec.model_validate(
        {
            "kohaku": "0.1",
            "intent": intent_arg.to_wire(),
            "dataVersion": "x",
            "components": [
                {"id": "root", "type": "layout.stack", "props": {}, "children": ["t", "c"]},
                {"id": "t", "type": "text.heading", "props": {"level": 2, "text": "Monthly sales trend"}},
                {
                    "id": "c",
                    "type": "presentChart",
                    "props": {"kind": "line", "x": "month", "y": "revenue"},
                    "data": {"$ref": handles[0].uri},
                },
            ],
            "events": [],
            "provenance": {"tier": "L0", "composedBy": "test", "cache": "miss"},
        }
    )


BIND_REF_US = "query://sales/trend?granularity=month&metric=revenue&region=us"


def bind_spec_builder(intent_arg: Intent, handles: list[QueryHandle]) -> UISpec:
    """A fixed Spec with a region-switch bind (us/eu/jp)."""
    return UISpec.model_validate(
        {
            "kohaku": "0.2",
            "intent": intent_arg.to_wire(),
            "dataVersion": "x",
            "state": {"region": "us"},
            "components": [
                {"id": "root", "type": "layout.stack", "props": {}, "children": ["c"]},
                {
                    "id": "c",
                    "type": "presentChart",
                    "props": {"kind": "line", "x": "month", "y": "revenue"},
                    "data": {
                        "$ref": handles[0].uri,
                        "bind": {"region": {"$state": "region", "values": ["us", "eu", "jp"]}},
                    },
                },
            ],
            "events": [],
            "provenance": {"tier": "L0", "composedBy": "test", "cache": "miss"},
        }
    )


def write_spec_builder(intent_arg: Intent, handles: list[QueryHandle]) -> UISpec:
    """A fixed Spec with presentForm (action=annotate) + an action.invoke event."""
    return UISpec.model_validate(
        {
            "kohaku": "0.1",
            "intent": intent_arg.to_wire(),
            "dataVersion": "x",
            "components": [
                {"id": "root", "type": "layout.stack", "props": {}, "children": ["f"]},
                {"id": "f", "type": "presentForm", "props": {"action": "annotate"}},
            ],
            "events": [{"on": "f.submit", "emit": "action.invoke", "payload": {}}],
            "provenance": {"tier": "L0", "composedBy": "test", "cache": "miss"},
        }
    )


def make_compose_ctx(
    tmp_path: Path,
    *,
    builder: Any = trend_spec_builder,
    canonical: str = "sales.trend",
    ref: str = TREND_REF,
) -> ComposeContext:
    from kohaku.storage import FileStoragePort

    return ComposeContext(
        catalog=CATALOG,
        semantic=_Semantic(canonical=canonical, ref=ref),
        storage=FileStoragePort(tmp_path),
        llm=FakeLlm(),
        policy=ComposePolicy(fixedSpecs=_fixed_source(builder)),
    )


def make_no_fixed_compose_ctx(
    tmp_path: Path,
    *,
    llm: Any,
    canonical: str = "sales.trend",
    ref: str = TREND_REF,
) -> ComposeContext:
    """A ComposeContext with no fixedSpecs (forces the L1 generation route, unlike make_compose_ctx's L0
    shortcut). Used by tests that need to exercise the LLM path directly — e.g. forcing every generation
    attempt to fail validation so compose exhausts into the deterministic fallback (kind="generation"),
    for view.fallback recording tests."""
    from kohaku.storage import FileStoragePort

    return ComposeContext(
        catalog=CATALOG,
        semantic=_Semantic(canonical=canonical, ref=ref),
        storage=FileStoragePort(tmp_path),
        llm=llm,
        policy=ComposePolicy(),
    )


@asynccontextmanager
async def connect(
    deps: McpHostDeps, options: AttachOptions, *, mode: str = "legacy"
) -> AsyncIterator[Client]:
    """Connect an in-process client to the attached low-level Server and yield it.

    mcp 2.x removed `mcp.shared.memory.create_connected_server_and_client_session`; `mcp.Client` now accepts a
    low-level `Server` instance directly and connects to it in-process (no real transport). `mode="legacy"`
    (the default here) drives the handshake-era `initialize` flow over an in-memory transport, byte-identical
    to the pre-2.x behavior this test suite was written against; `mode="2026-07-28"` instead dispatches
    directly (`DirectDispatcher`, no JSON-RPC framing) for tests that specifically exercise the modern wire.
    `cache=None` disables the client's default response cache (SEP-2549) so a scripted `list_tools()` call
    count in a test is not silently short-circuited by a cache hit.
    """
    server = Server("kohaku-host-mcp-test")
    attach_kohaku_to_mcp_server(server, deps, options)
    async with Client(server, mode=cast(Any, mode), cache=None) as client:
        yield client


def request_meta(**kwargs: Any) -> RequestParamsMeta:
    """Build a `RequestParamsMeta` (the `_meta` TypedDict mcp 2.x's `Client.call_tool(..., meta=...)` takes)
    from keyword arguments (e.g. `request_meta(traceparent=..., tracestate=...)`). A plain dict literal at a
    call site works fine at runtime (`RequestParamsMeta` is `extra_items=Any`), but mypy does not yet model
    PEP 728's `extra_items` for a `TypedDict` literal, so a `{"traceparent": ...}` dict literal passed directly
    as the `meta=` argument is flagged `call-overload`; this `cast` wrapper is the single place that absorbs it."""
    return cast(RequestParamsMeta, kwargs)


RENDERER_HTML_PLAIN = "<!DOCTYPE html><html><body>renderer</body></html>"
RENDERER_HTML_SNAPSHOT = (
    '<!DOCTYPE html><html><body><div id="root"></div>'
    '<script id="kohaku-snapshot" type="application/json">null</script></body></html>'
)
