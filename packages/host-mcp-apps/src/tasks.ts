/**
 * The MCP Tasks extension (io.modelcontextprotocol/tasks), dated-stable revision 2026-07-28.
 *
 * The installed SDK (@modelcontextprotocol/server 2.0.0) ships types for a DIFFERENT, deprecated
 * 2025-11-25 "tasks/*" wire vocabulary (`Task`, `GetTaskRequest`, `CreateTaskResult`, … — all marked
 * `@deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability
 * only`, and excluded from the typed `setRequestHandler` method surface). That vocabulary uses the same
 * method names (`tasks/get`, `tasks/cancel`) but a different result shape (nests under a `task` key) and
 * a different method set (`tasks/result`/`tasks/list` instead of `tasks/update`). This module defines
 * kohaku's own types for the actual 2026-07-28 extension from the specification directly, rather than
 * building on the deprecated SDK types — see server.ts's `registerTaskMethods` for the wire wiring and a
 * documented, empirically-verified SDK limitation this name collision causes.
 */
import { randomUUID } from "node:crypto";
import type { JsonObject } from "@kohaku-ui/spec-core";

/**
 * The ServerCapabilities.extensions / ClientCapabilities.extensions key for this extension. The server
 * declares support once (via `registerCapabilities` at attach time, surfaced on `server/discover`); a
 * client opts in **per request** via `params._meta["io.modelcontextprotocol/clientCapabilities"]
 * .extensions["io.modelcontextprotocol/tasks"]` (2026-07-28's per-request envelope — see server.ts's
 * `taskExtensionDeclared`). The spec's MUST NOT rule: a server must never return a `CreateTaskResult` to
 * a client that did not declare this on that specific request.
 */
export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";

export type TaskStatus = "working" | "input_required" | "completed" | "cancelled" | "failed";

interface TaskFields {
  taskId: string;
  statusMessage?: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  lastUpdatedAt: string;
  /** May change while the task is alive (spec). kohaku always sets a concrete value (never `null`, i.e.
   * never "no expiry") so the store's memory is always bounded — see createTaskStore's doc comment. */
  ttlMs: number | null;
  /** May change while the task is alive (spec). SHOULD, not MUST, on the client's side. */
  pollIntervalMs?: number;
}

/**
 * The wire shape of a task at any point in its lifecycle (`GetTaskResult = Result & DetailedTask`, and a
 * `CreateTaskResult` is `Result & Task` with `resultType: "task"` — see server.ts's `createTaskResult`).
 * kohaku never produces `"input_required"` (compose takes no mid-flight input — see this file's module
 * doc and server.ts's `registerTaskMethods` for why `tasks/update` is deliberately unimplemented), but the
 * type still models the full status union for spec fidelity.
 */
export type DetailedTask =
  | (TaskFields & { status: "working" })
  | (TaskFields & { status: "input_required"; inputRequests: JsonObject })
  | (TaskFields & { status: "completed"; result: JsonObject })
  | (TaskFields & { status: "cancelled" })
  | (TaskFields & { status: "failed"; error: JsonObject });

interface TaskRecord {
  task: DetailedTask;
  abort: AbortController;
  createdAtMs: number;
  ttlMs: number;
  /** The creator this task is bound to (see createTaskStore's "Ownership" note). */
  owner: string;
}

export interface TaskStore {
  /**
   * Creates a new task in "working" status. Returns the id, the `DetailedTask` snapshot (for building the
   * `CreateTaskResult` response), and the `AbortController` the caller must drive its cancellable work
   * with — `requestCancel` fires this same controller (see server.ts's `startComposeTask` for how compose
   * wires it into the composer's existing client-abort path).
   */
  create(opts: { owner: string; ttlMs: number; pollIntervalMs?: number }): {
    taskId: string;
    abort: AbortController;
    task: DetailedTask;
  };
  /** Transitions a task to "completed". No-op if the task is unknown, expired, or already terminal. */
  complete(taskId: string, result: JsonObject): void;
  /** Transitions a task to "failed". No-op if the task is unknown, expired, or already terminal. */
  fail(taskId: string, error: JsonObject): void;
  /**
   * Transitions a task to "cancelled" — called once the task's work has actually settled after a
   * `requestCancel` fired its `AbortController` (cancellation is non-blocking; the status only becomes
   * "cancelled" when the work unwinds, not synchronously on the cancel request). No-op if the task is
   * unknown, expired, or already terminal.
   */
  cancelled(taskId: string): void;
  /**
   * Looks up a task by id on behalf of `owner`. Lazily purges expired entries first (see createTaskStore's doc
   * comment), so this returns `undefined` for an unknown id, one whose `ttlMs` has elapsed, and —
   * indistinguishably — one that belongs to a different owner (an id alone must not reveal that a task exists).
   */
  get(taskId: string, owner: string): DetailedTask | undefined;
  /**
   * Requests cancellation on behalf of `owner` (spec: non-blocking, non-guaranteed — this only *asks*). Fires
   * the task's `AbortController` when it is still "working" (idempotent: a second call, or a call after the
   * task already settled one way or another, does nothing further). Returns `ok:false` only for an
   * unknown/expired id or one owned by someone else (indistinguishable, as in `get`) — an already-terminal
   * task still acks `ok:true` (a late cancel of a task that already finished is not an error per the spec's
   * non-blocking framing).
   */
  requestCancel(taskId: string, owner: string): { ok: true } | { ok: false };
}

/**
 * In-memory task store, one per `attachKohakuToMcpServer` call (see server.ts's `ToolContext.tasks`).
 *
 * Lifetime: a task outliving the process that computes it is useless (kohaku's compose is not
 * resumable/replayable from a serialized state — see docs/design.md's caching section: L0/L1/L2 results
 * are cached by content, not by a task id), so this deliberately does not persist to `StoragePort` /
 * `.data` the way promotion/fixation/lineage do. A process restart drops all in-flight tasks, which is
 * correct: the client's next `tasks/get` for a pre-restart id gets a fresh "unknown taskId" — the same
 * outcome as if the task had simply expired.
 *
 * Expiry: **no timer**. `apps/sample-mcp/src/setup.ts` already had to unref a sweep timer for snapshot
 * file cleanup (`snapshotSweepTimer.unref?.()`) precisely because a keep-alive timer is a real footgun for
 * a process shutdown path (see `KOHAKU_SHUTDOWN_GRACE_MS` / the SDK v2 migration's removal of the old
 * session-sweep timer). This store sidesteps the question entirely: every public entry point
 * (`create`/`get`/`requestCancel`) first purges any record whose `ttlMs` has elapsed (lazy, on-access
 * expiry). Memory is bounded because tasks are short-lived (bounded by `COMPOSE_TASK_TTL_MS`, tens of
 * minutes at most) and created only by explicit task-capable tool calls, not by a background process. A
 * still-working task that expires is also aborted (its body must not keep running unobservably).
 *
 * Ownership: every task is bound to an `owner` string (server.ts's `mcpTaskOwnerKey`: the resolved principal's id
 * when `resolvePrincipal` is wired, else `rateLimitKey`, else the session id, else `"anonymous"` — deliberately
 * not the rate-limit key, which a NAT'd IP-based `rateLimitKey` shares between distinct principals). `get` /
 * `requestCancel` answer exactly like an unknown id when the caller's owner differs, so a leaked task id alone
 * neither reveals that the task exists, nor lets its holder read the completed result (which carries the bearer
 * write capability in `_meta`), nor cancel it. The binding is only as strong as that key: with no
 * `resolvePrincipal` / `rateLimitKey` wired and no session id (stateless Streamable HTTP, stdio), every caller
 * is `"anonymous"` and shares an owner.
 */
export function createTaskStore(now: () => number = Date.now): TaskStore {
  const records = new Map<string, TaskRecord>();

  function purgeExpired(): void {
    const nowMs = now();
    for (const [id, record] of records) {
      if (nowMs - record.createdAtMs > record.ttlMs) {
        records.delete(id);
        if (record.task.status === "working") record.abort.abort(new Error("task expired"));
      }
    }
  }

  /** Rebuilds a record's `task` snapshot for a status transition, sharing the fields common to every status. */
  function settle(
    record: TaskRecord,
    patch:
      | { status: "completed"; result: JsonObject }
      | { status: "failed"; error: JsonObject }
      | { status: "cancelled" },
  ): void {
    const base = record.task;
    record.task = {
      taskId: base.taskId,
      createdAt: base.createdAt,
      lastUpdatedAt: new Date(now()).toISOString(),
      ttlMs: base.ttlMs,
      ...(base.pollIntervalMs != null ? { pollIntervalMs: base.pollIntervalMs } : {}),
      ...patch,
    } as DetailedTask;
  }

  function transitionIfWorking(
    taskId: string,
    patch:
      | { status: "completed"; result: JsonObject }
      | { status: "failed"; error: JsonObject }
      | { status: "cancelled" },
  ): void {
    const record = records.get(taskId);
    if (record == null || record.task.status !== "working") return;
    settle(record, patch);
  }

  return {
    create(opts) {
      purgeExpired();
      const taskId = randomUUID();
      const nowMs = now();
      const abort = new AbortController();
      const task: DetailedTask = {
        taskId,
        status: "working",
        createdAt: new Date(nowMs).toISOString(),
        lastUpdatedAt: new Date(nowMs).toISOString(),
        ttlMs: opts.ttlMs,
        ...(opts.pollIntervalMs != null ? { pollIntervalMs: opts.pollIntervalMs } : {}),
      };
      records.set(taskId, { task, abort, createdAtMs: nowMs, ttlMs: opts.ttlMs, owner: opts.owner });
      return { taskId, abort, task };
    },
    complete(taskId, result) {
      transitionIfWorking(taskId, { status: "completed", result });
    },
    fail(taskId, error) {
      transitionIfWorking(taskId, { status: "failed", error });
    },
    cancelled(taskId) {
      transitionIfWorking(taskId, { status: "cancelled" });
    },
    get(taskId, owner) {
      purgeExpired();
      const record = records.get(taskId);
      return record != null && record.owner === owner ? record.task : undefined;
    },
    requestCancel(taskId, owner) {
      purgeExpired();
      const record = records.get(taskId);
      if (record == null || record.owner !== owner) return { ok: false };
      if (record.task.status === "working") record.abort.abort(new Error("cancelled via tasks/cancel"));
      return { ok: true };
    },
  };
}

/** Builds the `CreateTaskResult` (`Result & Task` with `resultType: "task"`) a task-capable tool call
 * returns in place of executing synchronously. Deliberately a flat shape (not nested under a `task` key,
 * unlike the deprecated 2025-11-25 vocabulary's own `CreateTaskResult`) — this matches the actual
 * 2026-07-28 extension specification, at the cost of the installed SDK's `normalizeContentlessToolResult`
 * not recognizing it as a "foreign family" result and force-adding a harmless empty `content: []`
 * (verified empirically; see docs/design.md §11). Spec fidelity to the real wire format wins over
 * cosmetically avoiding that stray field. */
export function createTaskResult(task: DetailedTask): { resultType: "task" } & DetailedTask {
  return { resultType: "task", ...task };
}
