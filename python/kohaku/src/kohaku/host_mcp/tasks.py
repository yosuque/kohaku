"""The MCP Tasks extension (io.modelcontextprotocol/tasks), dated-stable revision 2026-07-28.

Port of packages/host-mcp-apps/src/tasks.ts.

The installed mcp SDK ships types for a DIFFERENT, 2025-11-25 "tasks/*" wire vocabulary (`Task`, `GetTaskRequest`,
`CreateTaskResult`, ... — all documented as "2025-11-25 only"). That vocabulary uses the same method names
(`tasks/get`, `tasks/cancel`) but a different result shape (nested under a `task` key) and a different method set
(`tasks/result` / `tasks/list` instead of `tasks/update`). This module defines kohaku's own wire-shaped snapshots for
the actual 2026-07-28 extension from the specification directly, rather than building on those types — the same
decision the TS profile made. The SDK's pluggable-extension seam (`Server.add_request_handler` for the two method
names, `Server.extensions` for the capability advertisement) is what carries them; see server.py's
`_register_task_methods`.

A task snapshot is a plain, wire-shaped `dict` (camelCase keys), so `tasks/get` returns it as stored and a
`CreateTaskResult` is just that snapshot plus `resultType: "task"`.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, Protocol

from kohaku.llm import AbortController

TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks"
"""The ServerCapabilities.extensions / ClientCapabilities.extensions key for this extension. The server declares
support once (`Server.extensions` at attach time, surfaced on `server/discover`); a client opts in **per request**
via `_meta["io.modelcontextprotocol/clientCapabilities"].extensions["io.modelcontextprotocol/tasks"]` (2026-07-28's
per-request envelope — see server.py's `_task_extension_declared`). The spec's MUST NOT rule: a server must never
return a `CreateTaskResult` to a client that did not declare this on that specific request."""

COMPOSE_TASK_TTL_MS = 600_000
"""Default `ttlMs` for a compose-backed task. Deliberately mirrors the 600s default this repo already uses for
capability issuance (host_core's `issue_capability_for_spec`) — a generous-but-bounded backstop rather than a
measured p99: `ComposeBudget.deadline_ms` is unset by default, so L1 + repair + L2 has no operator-configured hard
ceiling to derive a tighter number from. Same value as TS server.ts's COMPOSE_TASK_TTL_MS."""

COMPOSE_TASK_POLL_INTERVAL_MS = 2_000
"""Default `pollIntervalMs` for a compose-backed task: trades "feels responsive" against "don't hammer tasks/get"
for an operation measured in the tens of seconds, not milliseconds. Same value as TS server.ts's
COMPOSE_TASK_POLL_INTERVAL_MS."""

TaskStatus = Literal["working", "input_required", "completed", "cancelled", "failed"]
"""kohaku never produces "input_required" (compose takes no mid-flight input, so `tasks/update` is deliberately
unimplemented), but the union is kept complete for spec fidelity, as in TS."""

TaskSnapshot = dict[str, Any]
"""The wire shape of a task at any point in its lifecycle (`GetTaskResult = Result & DetailedTask`; a
`CreateTaskResult` is `Result & Task` with `resultType: "task"`). Keys: `taskId`, `status`, `createdAt` /
`lastUpdatedAt` (ISO 8601), `ttlMs` (always a concrete number — never "no expiry" — so the store's memory is
bounded), `pollIntervalMs` (optional), plus `result` (completed) / `error` (failed)."""


def _now_ms() -> float:
    return time.time() * 1000.0


def _iso(ms: float) -> str:
    """ISO 8601 UTC with millisecond precision and a `Z` suffix (JS `Date.prototype.toISOString`)."""
    return (
        datetime.fromtimestamp(ms / 1000.0, tz=UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


@dataclass(frozen=True)
class CreatedTask:
    """What `TaskStore.create` returns: the id, the abort controller the caller must drive its cancellable work
    with (`request_cancel` fires this same controller), and the "working" snapshot."""

    task_id: str
    abort: AbortController
    task: TaskSnapshot


class TaskStore(Protocol):
    def create(self, *, ttl_ms: int, poll_interval_ms: int | None = None) -> CreatedTask:
        """Creates a new task in "working" status."""
        ...

    def complete(self, task_id: str, result: dict[str, Any]) -> None:
        """Transitions a task to "completed". No-op if the task is unknown, expired, or already terminal."""
        ...

    def fail(self, task_id: str, error: dict[str, Any]) -> None:
        """Transitions a task to "failed". No-op if the task is unknown, expired, or already terminal."""
        ...

    def cancelled(self, task_id: str) -> None:
        """Transitions a task to "cancelled" — called once the task's work has actually settled after a
        `request_cancel` fired its abort controller (cancellation is non-blocking; the status only becomes
        "cancelled" when the work unwinds, not synchronously on the cancel request). No-op if the task is
        unknown, expired, or already terminal."""
        ...

    def get(self, task_id: str) -> TaskSnapshot | None:
        """Looks up a task by id. Lazily purges expired entries first, so this returns `None` for both an
        unknown id and one whose `ttlMs` has elapsed."""
        ...

    def request_cancel(self, task_id: str) -> bool:
        """Requests cancellation (spec: non-blocking, non-guaranteed — this only *asks*). Fires the task's abort
        controller when it is still "working" (idempotent). Returns `False` only for an unknown/expired id — an
        already-terminal task still acks `True` (a late cancel of a task that already finished is not an error
        per the spec's non-blocking framing). TS returns `{ok: boolean}`; Python returns the bool directly."""
        ...


@dataclass
class _TaskRecord:
    task: TaskSnapshot
    abort: AbortController
    created_at_ms: float
    ttl_ms: float


def create_task_store(now: Callable[[], float] = _now_ms) -> TaskStore:
    """In-memory task store, one per `attach_kohaku_to_mcp_server` call (see server.py).

    Lifetime: a task outliving the process that computes it is useless (kohaku's compose is not
    resumable/replayable from a serialized state — L0/L1/L2 results are cached by content, not by a task id), so
    this deliberately does not persist to `StoragePort`. A process restart drops all in-flight tasks, which is
    correct: the client's next `tasks/get` for a pre-restart id gets a fresh "unknown taskId" — the same outcome
    as if the task had simply expired.

    Expiry: **no timer**. Every public entry point (`create` / `get` / `request_cancel`) first purges any record
    whose `ttlMs` has elapsed (lazy, on-access expiry). Memory is bounded because tasks are short-lived (bounded by
    `COMPOSE_TASK_TTL_MS`) and created only by explicit task-capable tool calls, not by a background process.

    `now` returns epoch milliseconds (injectable for tests).
    """
    records: dict[str, _TaskRecord] = {}

    def purge_expired() -> None:
        now_ms = now()
        for task_id in [
            task_id
            for task_id, record in records.items()
            if now_ms - record.created_at_ms > record.ttl_ms
        ]:
            del records[task_id]

    def transition_if_working(task_id: str, patch: dict[str, Any]) -> None:
        record = records.get(task_id)
        if record is None or record.task["status"] != "working":
            return
        base = record.task
        # A fresh snapshot (the previous one is never mutated, so a snapshot handed out earlier stays valid).
        settled: TaskSnapshot = {
            "taskId": base["taskId"],
            "createdAt": base["createdAt"],
            "lastUpdatedAt": _iso(now()),
            "ttlMs": base["ttlMs"],
            **({"pollIntervalMs": base["pollIntervalMs"]} if "pollIntervalMs" in base else {}),
            **patch,
        }
        record.task = settled

    class _Store:
        def create(self, *, ttl_ms: int, poll_interval_ms: int | None = None) -> CreatedTask:
            purge_expired()
            task_id = str(uuid.uuid4())
            now_ms = now()
            abort = AbortController()
            task: TaskSnapshot = {
                "taskId": task_id,
                "status": "working",
                "createdAt": _iso(now_ms),
                "lastUpdatedAt": _iso(now_ms),
                "ttlMs": ttl_ms,
                **({"pollIntervalMs": poll_interval_ms} if poll_interval_ms is not None else {}),
            }
            records[task_id] = _TaskRecord(
                task=task, abort=abort, created_at_ms=now_ms, ttl_ms=ttl_ms
            )
            return CreatedTask(task_id=task_id, abort=abort, task=task)

        def complete(self, task_id: str, result: dict[str, Any]) -> None:
            transition_if_working(task_id, {"status": "completed", "result": result})

        def fail(self, task_id: str, error: dict[str, Any]) -> None:
            transition_if_working(task_id, {"status": "failed", "error": error})

        def cancelled(self, task_id: str) -> None:
            transition_if_working(task_id, {"status": "cancelled"})

        def get(self, task_id: str) -> TaskSnapshot | None:
            purge_expired()
            record = records.get(task_id)
            return record.task if record is not None else None

        def request_cancel(self, task_id: str) -> bool:
            purge_expired()
            record = records.get(task_id)
            if record is None:
                return False
            if record.task["status"] == "working":
                record.abort.abort(RuntimeError("cancelled via tasks/cancel"))
            return True

    return _Store()


def create_task_result(task: TaskSnapshot) -> dict[str, Any]:
    """Builds the `CreateTaskResult` (`Result & Task` with `resultType: "task"`) a task-capable tool call returns in
    place of executing synchronously. Deliberately a flat shape (not nested under a `task` key, unlike the
    deprecated 2025-11-25 vocabulary's own `CreateTaskResult`) — this matches the actual 2026-07-28 extension
    specification."""
    return {"resultType": "task", **task}
