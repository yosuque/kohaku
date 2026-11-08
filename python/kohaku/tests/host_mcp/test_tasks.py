"""Tests for the MCP Tasks extension (io.modelcontextprotocol/tasks, 2026-07-28 dated-stable).

pytest-ification of TS packages/host-mcp-apps/test/tasks.test.ts (see ../../src/kohaku/host_mcp/tasks.py and
server.py's `_register_task_methods` / `_task_extension_declared` / `_start_compose_task`).

Deviations from the TS file (the TS-test -> Python-test table is in the wp-g6 report):
 - TS declares the extension PER REQUEST by hand-building the `_meta` envelope (`sendRawModern`). The Python client
   stamps `_meta["io.modelcontextprotocol/clientCapabilities"]` unconditionally from its own `extensions=`, so
   per-request declaration is expressed here as two clients: one built with `advertise(TASKS_EXTENSION_ID)` (a
   "declaring" client) and one without. The server-side gate being exercised (`ctx.meta`) is the same.
 - `mcp.Client.call_tool` cannot decode a `resultType: "task"` result (its typed decoder rejects it, the same
   limitation TS's `Client.callTool()` has), so task-returning assertions go through `send_raw_request` below
   (a `CallToolRequest` sent through the session, with the result left as a plain dict).
 - Every test passes `mode="2026-07-28"`: the extension is a modern-era concept with no legacy-handshake form.
 - TS's `-32020 HeaderMismatch` test is a Streamable-HTTP binding behavior owned by the SDK's HTTP transport; the
   in-process direct dispatcher used here has no HTTP layer, so there is no counterpart (recorded in the report).
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import mcp_types
import pytest
from mcp import Client
from mcp.client.extension import advertise
from mcp.server import Server
from mcp.shared.exceptions import MCPError
from pydantic import BaseModel, ConfigDict

from kohaku.host_mcp import (
    AttachOptions,
    IntentToolDef,
    McpHostDeps,
    attach_kohaku_to_mcp_server,
)
from kohaku.host_mcp.server import _get_task_store_for_test
from kohaku.host_mcp.tasks import (
    COMPOSE_TASK_POLL_INTERVAL_MS,
    COMPOSE_TASK_TTL_MS,
    TASKS_EXTENSION_ID,
    TaskStore,
    create_task_store,
)
from kohaku.llm import GenerateObjectRequest, LlmError
from kohaku.spec import IntentInput, Principal

from ._helpers import (
    RENDERER_HTML_PLAIN,
    SimpleAuthz,
    TrendDomain,
    make_compose_ctx,
    make_no_fixed_compose_ctx,
)

# The owner every store test (and every wire test, via `_OwnerKey`) binds its tasks to.
_OWNER = "owner-a"

# ---------------------------------------------------------------------------
# TaskStore (create_task_store, in-memory, no timer)
# ---------------------------------------------------------------------------


class TestTaskStore:
    def test_create_returns_a_working_task_and_get_returns_the_same_snapshot(self) -> None:
        store = create_task_store()
        created = store.create(owner=_OWNER, ttl_ms=60_000, poll_interval_ms=2_000)
        assert created.task["status"] == "working"
        assert created.task["taskId"] == created.task_id
        assert created.task["ttlMs"] == 60_000
        assert created.task["pollIntervalMs"] == 2_000
        assert store.get(created.task_id, _OWNER) == created.task

    def test_complete_transitions_to_completed_and_a_second_complete_or_fail_is_a_no_op(
        self,
    ) -> None:
        store = create_task_store()
        task_id = store.create(owner=_OWNER, ttl_ms=60_000).task_id
        store.complete(task_id, {"spec": "x"})
        task = store.get(task_id, _OWNER)
        assert task is not None
        assert task["status"] == "completed"
        assert task["result"] == {"spec": "x"}

        # No-op once terminal (matches the store's "already-terminal" guard).
        store.fail(task_id, {"message": "too late"})
        after = store.get(task_id, _OWNER)
        assert after is not None
        assert after["status"] == "completed"

    def test_fail_transitions_to_failed_and_carries_the_error(self) -> None:
        store = create_task_store()
        task_id = store.create(owner=_OWNER, ttl_ms=60_000).task_id
        store.fail(task_id, {"message": "boom"})
        task = store.get(task_id, _OWNER)
        assert task is not None
        assert task["status"] == "failed"
        assert task["error"] == {"message": "boom"}

    def test_cancelled_transitions_to_cancelled_with_no_extra_fields(self) -> None:
        store = create_task_store()
        task_id = store.create(owner=_OWNER, ttl_ms=60_000).task_id
        store.cancelled(task_id)
        task = store.get(task_id, _OWNER)
        assert task is not None
        assert task["status"] == "cancelled"
        assert "result" not in task
        assert "error" not in task

    def test_request_cancel_fires_the_abort_signal_when_working_and_always_acks_a_known_id(
        self,
    ) -> None:
        store = create_task_store()
        created = store.create(owner=_OWNER, ttl_ms=60_000)
        assert created.abort.signal.aborted is False

        assert store.request_cancel(created.task_id, _OWNER) is True
        assert created.abort.signal.aborted is True

        # Idempotent: abort() firing does not itself flip status, so a second cancel still acks.
        assert store.request_cancel(created.task_id, _OWNER) is True

        # Once terminal, a cancel still acks (non-error per the spec's non-blocking framing).
        store.complete(created.task_id, {})
        assert store.request_cancel(created.task_id, _OWNER) is True

    def test_request_cancel_on_an_unknown_id_returns_false(self) -> None:
        store = create_task_store()
        assert store.request_cancel("no-such-task", _OWNER) is False

    def test_get_and_request_cancel_lazily_purge_an_expired_task(self) -> None:
        now = [1_000_000.0]
        store = create_task_store(lambda: now[0])
        task_id = store.create(owner=_OWNER, ttl_ms=1_000).task_id
        task = store.get(task_id, _OWNER)
        assert task is not None
        assert task["status"] == "working"

        now[0] += 1_001  # past ttl_ms
        assert store.get(task_id, _OWNER) is None
        assert store.request_cancel(task_id, _OWNER) is False

    def test_create_purges_other_expired_tasks(self) -> None:
        now = [0.0]
        store = create_task_store(lambda: now[0])
        old = store.create(owner=_OWNER, ttl_ms=100)
        now[0] += 200  # old has expired
        fresh = store.create(owner=_OWNER, ttl_ms=100)
        assert store.get(old.task_id, _OWNER) is None
        fresh_task = store.get(fresh.task_id, _OWNER)
        assert fresh_task is not None
        assert fresh_task["status"] == "working"

    def test_a_different_owner_sees_the_task_exactly_as_unknown(self) -> None:
        """Ownership: an id alone must neither reveal the task, nor return its result, nor cancel it."""
        store = create_task_store()
        created = store.create(owner=_OWNER, ttl_ms=60_000)
        store.complete(created.task_id, {"capability": "bearer-write-token"})

        assert store.get(created.task_id, "owner-b") is None
        assert store.get(created.task_id, "owner-b") == store.get("no-such-task", "owner-b")
        assert store.request_cancel(created.task_id, "owner-b") is False
        assert store.request_cancel(created.task_id, "owner-b") == store.request_cancel(
            "no-such-task", "owner-b"
        )
        # The creator is unaffected.
        assert store.get(created.task_id, _OWNER) is not None

    def test_a_foreign_cancel_does_not_fire_the_abort_signal(self) -> None:
        store = create_task_store()
        created = store.create(owner=_OWNER, ttl_ms=60_000)
        assert store.request_cancel(created.task_id, "owner-b") is False
        assert created.abort.signal.aborted is False

    def test_an_expired_working_task_is_aborted_when_purged(self) -> None:
        now = [0.0]
        store = create_task_store(lambda: now[0])
        created = store.create(owner=_OWNER, ttl_ms=100)
        now[0] += 200
        assert store.get(created.task_id, _OWNER) is None
        assert created.abort.signal.aborted is True

    def test_an_expired_terminal_task_is_not_aborted_when_purged(self) -> None:
        now = [0.0]
        store = create_task_store(lambda: now[0])
        created = store.create(owner=_OWNER, ttl_ms=100)
        store.complete(created.task_id, {})
        now[0] += 200
        assert store.get(created.task_id, _OWNER) is None
        assert created.abort.signal.aborted is False

    def test_cancel_requested_then_the_work_completes_normally_settles_as_completed(self) -> None:
        """Cancellation is non-blocking and non-guaranteed: the abort firing does not itself flip the status, so
        work that finishes anyway wins."""
        store = create_task_store()
        created = store.create(owner=_OWNER, ttl_ms=60_000)
        assert store.request_cancel(created.task_id, _OWNER) is True
        store.complete(created.task_id, {"spec": "x"})
        task = store.get(created.task_id, _OWNER)
        assert task is not None
        assert task["status"] == "completed"

    def test_cancel_requested_then_the_work_raises_settles_as_failed(self) -> None:
        store = create_task_store()
        created = store.create(owner=_OWNER, ttl_ms=60_000)
        assert store.request_cancel(created.task_id, _OWNER) is True
        store.fail(created.task_id, {"message": "boom"})
        task = store.get(created.task_id, _OWNER)
        assert task is not None
        assert task["status"] == "failed"
        assert task["error"] == {"message": "boom"}

    def test_timestamps_are_iso_8601_utc_with_millisecond_precision(self) -> None:
        store = create_task_store(lambda: 1_700_000_000_123.0)
        task = store.create(owner=_OWNER, ttl_ms=60_000).task
        assert task["createdAt"] == "2023-11-14T22:13:20.123Z"
        assert task["lastUpdatedAt"] == "2023-11-14T22:13:20.123Z"


def test_compose_task_constants_match_ts() -> None:
    """TS server.ts: COMPOSE_TASK_TTL_MS = 600_000, COMPOSE_TASK_POLL_INTERVAL_MS = 2_000."""
    assert COMPOSE_TASK_TTL_MS == 600_000
    assert COMPOSE_TASK_POLL_INTERVAL_MS == 2_000
    assert TASKS_EXTENSION_ID == "io.modelcontextprotocol/tasks"


# ---------------------------------------------------------------------------
# In-process wire helpers (modern 2026-07-28 era over the SDK's direct dispatcher)
# ---------------------------------------------------------------------------


class _RawResult(BaseModel):
    """Any result, undecoded: the SDK client's typed decoders reject the Tasks extension's result shapes."""

    model_config = ConfigDict(extra="allow")


async def _send_raw(client: Client, request: Any) -> dict[str, Any]:
    result = await client.session.send_request(request, _RawResult)
    return result.model_dump(by_alias=True, mode="json")


_DOMAIN = TrendDomain()
_AUTHZ = SimpleAuthz()


class _OwnerKey:
    """`McpHostDeps.rate_limit_key`: the owner every request is attributed to (a test flips `.value` to play a
    second caller). The Tasks extension keys task ownership on the same value the rate limiter would use."""

    def __init__(self, value: str = _OWNER) -> None:
        self.value = value

    def __call__(self, _ctx: Any) -> str:
        return self.value


def _deps(compose: Any, owner: _OwnerKey | None = None) -> McpHostDeps:
    return McpHostDeps(
        compose=compose,
        domain=_DOMAIN,
        authz=_AUTHZ,
        query_source="sales",
        rate_limit_key=owner if owner is not None else _OwnerKey(),
    )


@asynccontextmanager
async def _attached(
    compose: Any, *, tasks_enabled: bool, declare: bool = True, owner: _OwnerKey | None = None
) -> AsyncIterator[tuple[Server, Client]]:
    """A server with kohaku attached (tasks_enabled as given) plus a modern-era in-process client.

    `declare=True` builds a client that advertises the Tasks extension on every request it sends (the Python
    client stamps `_meta[clientCapabilities]` from its own `extensions=`; TS hand-builds the envelope per call).
    `cache=None` keeps a scripted `list_tools()` from being short-circuited by the client's response cache.
    """
    server = Server("kohaku-tasks-test")
    attach_kohaku_to_mcp_server(
        server,
        _deps(compose, owner),
        AttachOptions(renderer_html=RENDERER_HTML_PLAIN, tasks_enabled=tasks_enabled),
    )
    extensions = [advertise(TASKS_EXTENSION_ID)] if declare else None
    async with Client(server, mode="2026-07-28", cache=None, extensions=extensions) as client:
        yield server, client


async def _raw_call_tool(client: Client, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """`tools/call` with the result left as a plain dict: the SDK client's typed decoder cannot receive a
    `resultType: "task"` result (the same limitation TS's `Client.callTool()` has)."""
    request = mcp_types.CallToolRequest(
        params=mcp_types.CallToolRequestParams(name=name, arguments=arguments)
    )
    return await _send_raw(client, request)


async def _raw_tasks_get(client: Client, task_id: str) -> dict[str, Any]:
    request = mcp_types.GetTaskRequest(params=mcp_types.GetTaskRequestParams(task_id=task_id))
    return await _send_raw(client, request)


async def _raw_tasks_cancel(client: Client, task_id: str) -> dict[str, Any]:
    request = mcp_types.CancelTaskRequest(params=mcp_types.CancelTaskRequestParams(task_id=task_id))
    return await _send_raw(client, request)


def _store_of(server: Server) -> TaskStore:
    store = _get_task_store_for_test(server)
    assert store is not None
    return store


async def _tick(times: int = 20) -> None:
    for _ in range(times):
        await asyncio.sleep(0)


class _PendingUntilAbortLlm:
    """An LlmPort whose generate_object stays pending until `req.abort` fires, then rejects as ABORTED — the
    same shape the TS test's pendingUntilAbortLlm has, so the task-backed compose actually has something in flight
    to cancel (a fixedSpecs compose resolves too fast for that)."""

    provider = "abort-aware"
    model_id = "abort-model"

    def __init__(self) -> None:
        self.started = asyncio.Event()

    async def generate_object(self, req: GenerateObjectRequest) -> Any:
        self.started.set()
        loop = asyncio.get_running_loop()
        future: asyncio.Future[None] = loop.create_future()
        assert req.abort is not None

        def _on_abort() -> None:
            if not future.done():
                future.set_exception(LlmError("ABORTED", "aborted(test)"))

        req.abort.add_listener(_on_abort)
        await future
        raise AssertionError("unreachable")

    async def generate_text(self, req: Any) -> Any:
        raise AssertionError("_PendingUntilAbortLlm stub: generate_text not supported")


# ---------------------------------------------------------------------------
# Per-request opt-in gate, with tasks_enabled=True
# ---------------------------------------------------------------------------


class TestPerRequestOptInGate:
    """Spec MUST: a server MUST NOT return a CreateTaskResult to a client that did not declare the extension."""

    def test_a_request_that_does_not_declare_the_extension_gets_the_synchronous_result(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            async with _attached(make_compose_ctx(tmp_path), tasks_enabled=True, declare=False) as (
                _server,
                client,
            ):
                result = await client.call_tool(
                    "kohaku_compose", {"question": "Monthly revenue trend"}
                )
                assert not result.is_error
                # Today's shape: content + structuredContent.spec, no task fields at all.
                assert result.structured_content is not None
                assert "spec" in result.structured_content
                dumped = result.model_dump(by_alias=True, mode="json")
                assert "taskId" not in dumped
                assert dumped.get("resultType") != "task"

        asyncio.run(run())

    def test_a_declaring_request_on_kohaku_compose_gets_a_create_task_result(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            async with _attached(make_compose_ctx(tmp_path), tasks_enabled=True) as (
                server,
                client,
            ):
                result = await _raw_call_tool(
                    client, "kohaku_compose", {"question": "Monthly revenue trend"}
                )
                assert result["resultType"] == "task"
                assert isinstance(result["taskId"], str)
                assert result["status"] == "working"
                assert isinstance(result["createdAt"], str)
                assert isinstance(result["lastUpdatedAt"], str)
                assert result["ttlMs"] == 600_000
                assert result["pollIntervalMs"] == 2_000
                # Not part of the CreateTaskResult shape (that's the synchronous packaged result's shape).
                assert "structuredContent" not in result

                # The store actually holds a "working" task under this id (proves the tool call really started
                # a task, not just stamped fake-looking fields on a synchronous response).
                task = _store_of(server).get(result["taskId"], _OWNER)
                assert task is not None
                assert task["status"] == "working"
                await (
                    _tick()
                )  # let the fixedSpecs compose settle so it doesn't dangle past the test

        asyncio.run(run())

    def test_server_discover_reports_the_extension_in_server_capabilities_extensions(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            async with _attached(make_compose_ctx(tmp_path), tasks_enabled=True) as (
                server,
                _client,
            ):
                capabilities = server.get_capabilities(protocol_version="2026-07-28")
                assert capabilities.extensions is not None
                assert TASKS_EXTENSION_ID in capabilities.extensions

        asyncio.run(run())

    def test_an_intent_tool_is_task_capable_on_the_same_basis(self, tmp_path: Path) -> None:
        """TS covers the intent tools through the shared composeOrStartTask; pin the Python counterpart too."""

        async def run() -> None:
            tool = IntentToolDef(
                name="sales_trend",
                description="Trend",
                input_schema={"type": "object", "properties": {}},
                to_intent=lambda params: IntentInput(canonical="sales.trend", params=dict(params)),
            )
            server = Server("kohaku-tasks-intent-test")
            attach_kohaku_to_mcp_server(
                server,
                _deps(make_compose_ctx(tmp_path)),
                AttachOptions(
                    renderer_html=RENDERER_HTML_PLAIN, intent_tools=[tool], tasks_enabled=True
                ),
            )
            async with Client(
                server, mode="2026-07-28", cache=None, extensions=[advertise(TASKS_EXTENSION_ID)]
            ) as client:
                result = await _raw_call_tool(client, "sales_trend", {})
                assert result["resultType"] == "task"
                assert result["status"] == "working"
                await _tick()

        asyncio.run(run())


class TestTasksEnabledDefaultOffKillSwitch:
    """AttachOptions.tasks_enabled default-off kill switch."""

    def test_the_shipped_default_is_off(self) -> None:
        assert AttachOptions(renderer_html="<html></html>").tasks_enabled is False

    def test_with_tasks_enabled_off_a_declaring_request_still_gets_the_synchronous_result(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            async with _attached(make_compose_ctx(tmp_path), tasks_enabled=False) as (_s, client):
                result = await _raw_call_tool(
                    client, "kohaku_compose", {"question": "Monthly revenue trend"}
                )
                # A declaring client gets exactly what a non-declaring client gets: resultType "complete", the
                # normal packaged shape, no task fields at all — the whole point of the kill switch.
                assert result["resultType"] == "complete"
                assert "taskId" not in result
                assert "spec" in result["structuredContent"]

        asyncio.run(run())

    def test_with_tasks_enabled_off_the_server_does_not_declare_the_extension(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            async with _attached(make_compose_ctx(tmp_path), tasks_enabled=False) as (server, _c):
                capabilities = server.get_capabilities(protocol_version="2026-07-28")
                assert TASKS_EXTENSION_ID not in (capabilities.extensions or {})

        asyncio.run(run())

    def test_with_tasks_enabled_off_tasks_get_and_tasks_cancel_are_not_registered(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            async with _attached(make_compose_ctx(tmp_path), tasks_enabled=False) as (_s, client):
                for send in (_raw_tasks_get, _raw_tasks_cancel):
                    # Off means an unregistered method, byte-identical to a server that never heard of the
                    # extension: METHOD_NOT_FOUND (TS: -32601).
                    with pytest.raises(MCPError) as excinfo:
                        await send(client, "whatever")
                    assert excinfo.value.code == mcp_types.METHOD_NOT_FOUND

        asyncio.run(run())


# ---------------------------------------------------------------------------
# tasks/get and tasks/cancel reach kohaku's handlers
# ---------------------------------------------------------------------------


class TestTasksGetAndCancel:
    # Not ported from the TS "reachability" block: the `-32020 HeaderMismatch` test for a `tasks/get` / `tasks/cancel`
    # request without `Mcp-Name: <taskId>`. That rule is SEP-2663's Streamable HTTP binding, enforced by the SDK's
    # HTTP transport before any handler runs; this suite drives the in-process direct dispatcher, which has no
    # headers, and kohaku's own code has no part in it.

    def test_tasks_get_reaches_the_handler_and_returns_the_task_snapshot(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            async with _attached(make_compose_ctx(tmp_path), tasks_enabled=True) as (
                server,
                client,
            ):
                task_id = _store_of(server).create(owner=_OWNER, ttl_ms=60_000).task_id
                result = await _raw_tasks_get(client, task_id)
                assert result["taskId"] == task_id
                assert result["status"] == "working"
                assert result["ttlMs"] == 60_000

        asyncio.run(run())

    def test_tasks_cancel_reaches_the_handler_acks_and_fires_the_abort_signal(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            async with _attached(make_compose_ctx(tmp_path), tasks_enabled=True) as (
                server,
                client,
            ):
                created = _store_of(server).create(owner=_OWNER, ttl_ms=60_000)
                await _raw_tasks_cancel(client, created.task_id)
                assert created.abort.signal.aborted is True

        asyncio.run(run())

    def test_an_unknown_or_expired_task_id_is_invalid_params_for_both_methods(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            async with _attached(make_compose_ctx(tmp_path), tasks_enabled=True) as (_s, client):
                for send in (_raw_tasks_get, _raw_tasks_cancel):
                    with pytest.raises(MCPError) as excinfo:
                        await send(client, "no-such-task")
                    # InvalidParams, not Method not found.
                    assert excinfo.value.code == mcp_types.INVALID_PARAMS

        asyncio.run(run())

    def test_polling_tasks_get_after_a_task_backed_call_observes_working_then_completed(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            async with _attached(make_compose_ctx(tmp_path), tasks_enabled=True) as (_s, client):
                created = await _raw_call_tool(
                    client, "kohaku_compose", {"question": "Monthly revenue trend"}
                )
                assert created["resultType"] == "task"
                task_id = created["taskId"]

                polled: dict[str, Any] = {}
                for _attempt in range(50):
                    polled = await _raw_tasks_get(client, task_id)
                    if polled["status"] != "working":
                        break
                    await _tick(2)
                assert polled["taskId"] == task_id
                assert polled["status"] == "completed"
                # The completed task carries the same packaged result a synchronous call would have returned.
                assert "spec" in polled["result"]["structuredContent"]

        asyncio.run(run())


class TestTaskOwnership:
    """Tasks are bound to their creator: a leaked task id alone must not read or cancel the task."""

    def test_another_caller_gets_the_unknown_task_answer_for_get_and_cancel(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            owner = _OwnerKey("owner-a")
            async with _attached(make_compose_ctx(tmp_path), tasks_enabled=True, owner=owner) as (
                server,
                client,
            ):
                created = await _raw_call_tool(
                    client, "kohaku_compose", {"question": "Monthly revenue trend"}
                )
                task_id = created["taskId"]
                for _attempt in range(50):
                    polled = await _raw_tasks_get(client, task_id)
                    if polled["status"] != "working":
                        break
                    await _tick(2)
                assert polled["status"] == "completed"
                assert "_meta" in polled["result"]  # the result carries the bearer write capability

                owner.value = "owner-b"
                answers = []
                for send in (_raw_tasks_get, _raw_tasks_cancel):
                    with pytest.raises(MCPError) as known:
                        await send(client, task_id)
                    with pytest.raises(MCPError) as unknown:
                        await send(client, "no-such-task")
                    assert known.value.code == mcp_types.INVALID_PARAMS
                    assert known.value.code == unknown.value.code
                    answers.append(known.value.message.replace(task_id, "ID"))
                    # Indistinguishable from an unknown id apart from the echoed id itself.
                    assert known.value.message.replace(
                        task_id, "ID"
                    ) == unknown.value.message.replace("no-such-task", "ID")
                assert len(answers) == 2

                # The creator still sees it.
                owner.value = "owner-a"
                again = await _raw_tasks_get(client, task_id)
                assert again["status"] == "completed"
                assert _store_of(server).get(task_id, "owner-b") is None

        asyncio.run(run())

    def test_a_foreign_tasks_cancel_does_not_abort_the_task(self, tmp_path: Path) -> None:
        async def run() -> None:
            owner = _OwnerKey("owner-a")
            async with _attached(make_compose_ctx(tmp_path), tasks_enabled=True, owner=owner) as (
                server,
                client,
            ):
                created = _store_of(server).create(owner="owner-a", ttl_ms=60_000)
                owner.value = "owner-b"
                with pytest.raises(MCPError):
                    await _raw_tasks_cancel(client, created.task_id)
                assert created.abort.signal.aborted is False

        asyncio.run(run())

    def test_the_echoed_task_id_in_the_error_message_is_capped(self, tmp_path: Path) -> None:
        async def run() -> None:
            async with _attached(make_compose_ctx(tmp_path), tasks_enabled=True) as (_s, client):
                huge = "x" * 5_000
                for send in (_raw_tasks_get, _raw_tasks_cancel):
                    with pytest.raises(MCPError) as excinfo:
                        await send(client, huge)
                    assert excinfo.value.code == mcp_types.INVALID_PARAMS
                    assert len(excinfo.value.message) < 200
                    assert "x" * 129 not in excinfo.value.message

        asyncio.run(run())

    def test_a_task_is_attributed_to_the_rate_limit_key_of_its_creating_call(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            owner = _OwnerKey("owner-a")
            async with _attached(make_compose_ctx(tmp_path), tasks_enabled=True, owner=owner) as (
                server,
                client,
            ):
                owner.value = "owner-c"
                created = await _raw_call_tool(
                    client, "kohaku_compose", {"question": "Monthly revenue trend"}
                )
                assert _store_of(server).get(created["taskId"], "owner-c") is not None
                assert _store_of(server).get(created["taskId"], "owner-a") is None
                await _tick()

        asyncio.run(run())


class TestTaskOwnerIsThePrincipalNotTheRateLimitKey:
    """Two authenticated principals behind one NAT share an IP-based `rate_limit_key`; the task owner must differ
    (counterpart of the TS "task ownership binds to the resolved principal" block)."""

    @staticmethod
    @asynccontextmanager
    async def _attached_with_principals(
        tmp_path: Path, current: dict[str, str]
    ) -> AsyncIterator[tuple[Server, Client]]:
        server = Server("kohaku-tasks-owner-test")
        attach_kohaku_to_mcp_server(
            server,
            McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=_DOMAIN,
                authz=_AUTHZ,
                query_source="sales",
                resolve_principal=lambda _ctx: Principal(id=current["id"]),
                rate_limit_key=lambda _ctx: "shared-nat-ip",
            ),
            AttachOptions(renderer_html=RENDERER_HTML_PLAIN, tasks_enabled=True),
        )
        async with Client(
            server, mode="2026-07-28", cache=None, extensions=[advertise(TASKS_EXTENSION_ID)]
        ) as client:
            yield server, client

    def test_a_second_principal_sharing_the_rate_limit_key_cannot_get_or_cancel_the_task(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            current = {"id": "alice"}
            async with self._attached_with_principals(tmp_path, current) as (_server, client):
                created = await _raw_call_tool(
                    client, "kohaku_compose", {"question": "Monthly revenue trend"}
                )
                task_id = created["taskId"]
                await _tick()

                current["id"] = "bob"
                for send in (_raw_tasks_get, _raw_tasks_cancel):
                    with pytest.raises(MCPError) as denied:
                        await send(client, task_id)
                    assert denied.value.code == mcp_types.INVALID_PARAMS

                current["id"] = "alice"
                own = await _raw_tasks_get(client, task_id)
                assert own["taskId"] == task_id
                await _raw_tasks_cancel(client, task_id)

        asyncio.run(run())

    def test_the_task_is_attributed_to_the_resolved_principal_id(self, tmp_path: Path) -> None:
        async def run() -> None:
            current = {"id": "carol"}
            async with self._attached_with_principals(tmp_path, current) as (server, client):
                created = await _raw_call_tool(
                    client, "kohaku_compose", {"question": "Monthly revenue trend"}
                )
                assert _store_of(server).get(created["taskId"], "carol") is not None
                assert _store_of(server).get(created["taskId"], "shared-nat-ip") is None
                await _tick()

        asyncio.run(run())


# ---------------------------------------------------------------------------
# Cancellation wiring and failure messages
# ---------------------------------------------------------------------------


class TestCancellationWiring:
    def test_cancel_after_completion_and_a_double_cancel_ack_and_leave_the_status(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            async with _attached(make_compose_ctx(tmp_path), tasks_enabled=True) as (_s, client):
                created = await _raw_call_tool(
                    client, "kohaku_compose", {"question": "Monthly revenue trend"}
                )
                task_id = created["taskId"]
                for _attempt in range(50):
                    polled = await _raw_tasks_get(client, task_id)
                    if polled["status"] != "working":
                        break
                    await _tick(2)
                assert polled["status"] == "completed"

                # A late cancel of a finished task is an ack, not an error, and does not flip the status;
                # a second cancel is the same.
                await _raw_tasks_cancel(client, task_id)
                await _raw_tasks_cancel(client, task_id)
                assert (await _raw_tasks_get(client, task_id))["status"] == "completed"

        asyncio.run(run())

    def test_a_double_cancel_of_a_working_task_acks_both_times(self, tmp_path: Path) -> None:
        async def run() -> None:
            llm = _PendingUntilAbortLlm()
            compose = make_no_fixed_compose_ctx(tmp_path, llm=llm)
            async with _attached(compose, tasks_enabled=True) as (server, client):
                created = await _raw_call_tool(
                    client, "kohaku_compose", {"question": "Monthly revenue trend"}
                )
                task_id = created["taskId"]
                await asyncio.wait_for(llm.started.wait(), timeout=5)
                await _raw_tasks_cancel(client, task_id)
                await _raw_tasks_cancel(client, task_id)
                for _attempt in range(100):
                    final = _store_of(server).get(task_id, _OWNER)
                    if final is not None and final["status"] != "working":
                        break
                    await asyncio.sleep(0.01)
                final = _store_of(server).get(task_id, _OWNER)
                assert final is not None
                assert final["status"] == "cancelled"
                # ... and a cancel after the task settled as cancelled still acks.
                await _raw_tasks_cancel(client, task_id)

        asyncio.run(run())

    def test_a_real_tasks_cancel_settles_a_mid_generation_compose_as_cancelled(
        self, tmp_path: Path
    ) -> None:
        """A real tasks/cancel rides the composer's existing client-abort path: cancelling a task-backed compose
        mid-generation settles the task as cancelled, not completed or failed."""

        async def run() -> None:
            llm = _PendingUntilAbortLlm()
            compose = make_no_fixed_compose_ctx(tmp_path, llm=llm)
            async with _attached(compose, tasks_enabled=True) as (server, client):
                result = await _raw_call_tool(
                    client, "kohaku_compose", {"question": "Monthly revenue trend"}
                )
                assert result["resultType"] == "task"
                task_id = result["taskId"]
                task = _store_of(server).get(task_id, _OWNER)
                assert task is not None
                assert task["status"] == "working"

                # Wait until the LLM call is actually in flight before cancelling (a pre-abort would never
                # exercise the in-flight abort path).
                await asyncio.wait_for(llm.started.wait(), timeout=5)
                await _raw_tasks_cancel(client, task_id)

                for _attempt in range(100):
                    final = _store_of(server).get(task_id, _OWNER)
                    if final is not None and final["status"] != "working":
                        break
                    await asyncio.sleep(0.01)
                final = _store_of(server).get(task_id, _OWNER)
                assert final is not None
                assert final["status"] == "cancelled"

                # And a client polling over the wire sees the same terminal state.
                polled = await _raw_tasks_get(client, task_id)
                assert polled["taskId"] == task_id
                assert polled["status"] == "cancelled"

        asyncio.run(run())

    def test_a_failing_task_body_settles_as_failed_with_the_fixed_client_message(
        self, tmp_path: Path
    ) -> None:
        """Fixed failure messages: a task's failure reaches the client through tasks/get, so a raw provider SDK
        message must not be stored there (host_core's LLM_PROVIDER_UNAVAILABLE_MESSAGE instead); an untyped error
        collapses to the tool-internal message. Both are the same text _safe_tool uses."""
        from kohaku.host_core import LLM_PROVIDER_UNAVAILABLE_MESSAGE
        from kohaku.host_mcp.server import _TOOL_INTERNAL_ERROR_MESSAGE

        async def run() -> None:
            for exc, expected in (
                (
                    LlmError("PROVIDER", "secret key sk-123 invalid"),
                    LLM_PROVIDER_UNAVAILABLE_MESSAGE,
                ),
                (RuntimeError("secret internals"), _TOOL_INTERNAL_ERROR_MESSAGE),
            ):
                compose = make_compose_ctx(tmp_path)
                semantic = compose.semantic

                async def _failing_normalize(*_a: Any, _exc: BaseException = exc, **_k: Any) -> Any:
                    raise _exc

                semantic.normalize = _failing_normalize  # type: ignore[method-assign]
                async with _attached(compose, tasks_enabled=True) as (server, client):
                    created = await _raw_call_tool(
                        client, "kohaku_compose", {"question": "Monthly revenue trend"}
                    )
                    assert created["resultType"] == "task"
                    task_id = created["taskId"]
                    for _attempt in range(100):
                        final = _store_of(server).get(task_id, _OWNER)
                        if final is not None and final["status"] != "working":
                            break
                        await asyncio.sleep(0.01)
                    final = _store_of(server).get(task_id, _OWNER)
                    assert final is not None
                    assert final["status"] == "failed"
                    assert final["error"] == {"message": expected}
                    assert "sk-123" not in str(final)
                    assert "secret" not in str(final)

        asyncio.run(run())

    def test_a_failing_task_body_is_reported_to_on_error_as_tasks_compose(
        self, tmp_path: Path
    ) -> None:
        errors: list[Any] = []

        async def run() -> None:
            compose = make_compose_ctx(tmp_path)

            async def _failing_normalize(*_a: Any, **_k: Any) -> Any:
                raise RuntimeError("boom")

            compose.semantic.normalize = _failing_normalize  # type: ignore[method-assign]
            server = Server("kohaku-tasks-onerror-test")
            deps = McpHostDeps(
                compose=compose,
                domain=_DOMAIN,
                authz=_AUTHZ,
                query_source="sales",
                rate_limit_key=_OwnerKey(),
                on_error=errors.append,
            )
            attach_kohaku_to_mcp_server(
                server,
                deps,
                AttachOptions(renderer_html=RENDERER_HTML_PLAIN, tasks_enabled=True),
            )
            async with Client(
                server, mode="2026-07-28", cache=None, extensions=[advertise(TASKS_EXTENSION_ID)]
            ) as client:
                created = await _raw_call_tool(
                    client, "kohaku_compose", {"question": "Monthly revenue trend"}
                )
                for _attempt in range(100):
                    final = _store_of(server).get(created["taskId"], _OWNER)
                    if final is not None and final["status"] != "working":
                        break
                    await asyncio.sleep(0.01)
            assert [e.endpoint for e in errors] == ["tasks.compose"]

        asyncio.run(run())
