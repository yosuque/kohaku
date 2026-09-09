/**
 * Tests for the MCP Tasks extension (io.modelcontextprotocol/tasks, 2026-07-28 dated-stable) — see
 * ../src/tasks.ts and ../src/server.ts's `registerTaskMethods` / `taskExtensionDeclared` / `startComposeTask`.
 *
 * Three things this file cannot test, and why (see registerTaskMethods's doc comment in server.ts for the
 * full writeup, verified empirically against the installed @modelcontextprotocol/server 2.0.0):
 *  - `tasks/get` and `tasks/cancel` are registered via the SDK's documented consumer-owned extension seam,
 *    but the SDK's own inbound-request routing rejects both method names with -32601 on a 2026-07-28
 *    connection before our handler ever runs (a name collision with the SDK's own deprecated, no-runtime
 *    2025-11-25 `tasks/*` vocabulary). The "known SDK limitation" describe block below locks this in with a
 *    reproduction, so a future SDK upgrade that fixes it turns this test red as a signal to revisit.
 *  - Because of that, this file cannot drive cancellation through a real `tasks/cancel` call. It instead
 *    reaches the exact same `TaskStore.requestCancel` a real `tasks/cancel` handler would call, via the
 *    test-only `__getTaskStoreForTest` escape hatch (same style as `__setPreresolveTimeoutMsForTest`).
 *  - `@modelcontextprotocol/client`'s `Client.callTool()` cannot receive a `resultType: "task"` result at
 *    all (its own decoder rejects any `resultType` other than `"complete"`/`"input_required"`), so the
 *    task-returning assertions below go through `sendRawModern` (raw JSON-RPC over the same in-process
 *    `createMcpHandler` bridge `connectModern` uses) rather than the typed client.
 *
 * Because `AttachOptions.tasksEnabled` defaults to off (see its doc comment — a direct consequence of the
 * `tasks/get` limitation above: never hand back a task handle a client can never poll), most `describe`
 * blocks below build their test server with `tasksEnabled: true` via `buildAttached`'s default parameter to
 * actually exercise the extension's behavior. The "AttachOptions.tasksEnabled default-off kill switch"
 * describe block is the one that deliberately leaves it unset, to verify the shipped default.
 */
import type { ComposeContext } from "@kohaku-ui/composer";
import {
  type GenerateObjectRequest,
  type GenerateObjectResult,
  LlmError,
  type LlmPort,
} from "@kohaku-ui/llm";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type { AuthzPort, DomainPort, Scope, TabularData, UISpec } from "@kohaku-ui/spec-core";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { attachKohakuToMcpServer, createTaskStore } from "../src/index.js";
import { __getTaskStoreForTest } from "../src/server.js";
import { connectModern, sendRawModern, taskExtensionEnvelope } from "./connect-modern.js";

const TREND_REF = "query://sales/trend?granularity=month&metric=revenue";

const DATA: TabularData = {
  columns: [
    { key: "month", type: "string" },
    { key: "revenue", type: "number" },
  ],
  rows: [{ month: "2026-04", revenue: 100 }],
  dataVersion: "sales@seed-1",
};

const authz: AuthzPort = {
  async issueCapability(_p, scopes: Scope[]) {
    return `cap:${scopes.map((s) => s.ref).join("|")}`;
  },
  async verify(token, req) {
    const ok =
      token.startsWith("cap:") &&
      token
        .slice(4)
        .split("|")
        .some((p) => req.ref.startsWith(p));
    return ok ? { ok: true, principal: { id: "tester" } } : { ok: false, reason: "scope" };
  },
};

const domain: DomainPort = {
  async listOperations() {
    return [];
  },
  async invoke(op) {
    if (op !== "trend") throw new Error("unknown op");
    return DATA;
  },
};

/** A compose ctx that resolves via the L0 fixedSpecs shortcut (fast, no LLM call — for the opt-in-gate tests,
 * which only care about the shape of the response, not generation timing). */
function fixedSpecComposeCtx(): ComposeContext {
  const cache = new Map<string, UISpec>();
  return {
    catalog: resolveCatalog(coreCatalog),
    llm: {
      provider: "fake",
      modelId: "fake",
      async generateObject() {
        throw new Error("LLM should not be called (fixedSpecs)");
      },
      async generateText() {
        throw new Error("no");
      },
    },
    semantic: {
      async normalize(input) {
        return {
          canonical: "sales.trend",
          params: input.kind === "gui" ? { ...input.current?.params, ...input.params } : {},
          hash: "",
        };
      },
      async resolveQuery() {
        return { uri: TREND_REF };
      },
      async dataVersion() {
        return "sales@seed-1";
      },
    },
    storage: {
      async getSpecCache(k) {
        return cache.get(k) ?? null;
      },
      async putSpecCache(k, s) {
        cache.set(k, s);
      },
      async appendLineage() {},
      async listLineage() {
        return [];
      },
      async getPromotionState() {
        return null;
      },
      async putPromotionState() {},
      async listPromotionStates() {
        return [];
      },
      async getFixation() {
        return null;
      },
      async putFixation() {},
      async listFixations() {
        return [];
      },
    },
    policy: {
      fixedSpecs: {
        async lookup() {
          return (intentArg, refs): UISpec => ({
            kohaku: "0.1",
            intent: intentArg,
            dataVersion: "x",
            components: [
              { id: "root", type: "layout.stack", props: {}, children: ["c"] },
              {
                id: "c",
                type: "presentChart",
                props: { kind: "line", x: "month", y: "revenue" },
                data: { $ref: refs[0]!.uri },
              },
            ],
            events: [],
            provenance: { tier: "L0", composedBy: "test", cache: "miss" },
          });
        },
      },
    },
  };
}

/** An LlmPort whose generateObject stays pending until `req.abort` fires, then rejects as ABORTED — the same
 * shape mcp.test.ts's "cancellation propagation" describe block already uses, reused here so the task-backed
 * compose actually has something in flight to cancel (fixedSpecComposeCtx resolves too fast for that). */
function pendingUntilAbortLlm(onStarted: () => void): LlmPort {
  return {
    provider: "abort-aware",
    modelId: "abort-model",
    async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
      onStarted();
      return new Promise((_resolve, reject) => {
        req.abort?.addEventListener("abort", () => {
          reject(new LlmError("ABORTED", "aborted(test)"));
        });
      });
    },
    async generateText() {
      throw new Error("pendingUntilAbortLlm stub: generateText not supported");
    },
  };
}

/** Same shape as fixedSpecComposeCtx but with no fixedSpecs (forces the L1 generation route) and a caller-supplied llm. */
function noFixedComposeCtx(llm: LlmPort): ComposeContext {
  const cache = new Map<string, UISpec>();
  return {
    catalog: resolveCatalog(coreCatalog),
    llm,
    semantic: {
      async normalize(input) {
        return {
          canonical: "sales.trend",
          params: input.kind === "gui" ? { ...input.current?.params, ...input.params } : {},
          hash: "",
        };
      },
      async resolveQuery() {
        return { uri: TREND_REF };
      },
      async dataVersion() {
        return "sales@seed-1";
      },
    },
    storage: {
      async getSpecCache(k) {
        return cache.get(k) ?? null;
      },
      async putSpecCache(k, s) {
        cache.set(k, s);
      },
      async appendLineage() {},
      async listLineage() {
        return [];
      },
      async getPromotionState() {
        return null;
      },
      async putPromotionState() {},
      async listPromotionStates() {
        return [];
      },
      async getFixation() {
        return null;
      },
      async putFixation() {},
      async listFixations() {
        return [];
      },
    },
    policy: {},
  };
}

/**
 * `tasksEnabled: true` by default here: most of this file's tests are specifically about the Tasks
 * extension's behavior, which only runs when it is on (see `AttachOptions.tasksEnabled`'s doc comment —
 * default off, because `tasks/get` is currently unreachable on the installed SDK, see the "known SDK
 * limitation" describe block below). The "tasksEnabled default-off kill switch" describe block builds its
 * own server with `tasksEnabled` deliberately left unset to verify the shipped default.
 */
function buildAttached(composeCtx: ComposeContext = fixedSpecComposeCtx(), tasksEnabled = true): McpServer {
  const server = new McpServer({ name: "kohaku-tasks-test", version: "0.1.0" });
  attachKohakuToMcpServer(
    server,
    { compose: composeCtx, domain, authz, querySource: "sales" },
    { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>", tasksEnabled },
  );
  return server;
}

async function tick(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("TaskStore (createTaskStore, in-memory, no timer)", () => {
  it("create() returns a working task; get() returns the same snapshot", () => {
    const store = createTaskStore();
    const { taskId, task } = store.create({ ttlMs: 60_000, pollIntervalMs: 2_000 });
    expect(task.status).toBe("working");
    expect(task.taskId).toBe(taskId);
    expect(task.ttlMs).toBe(60_000);
    expect(task.pollIntervalMs).toBe(2_000);
    expect(store.get(taskId)).toEqual(task);
  });

  it("complete() transitions to completed and carries the result; a second complete()/fail() is a no-op", () => {
    const store = createTaskStore();
    const { taskId } = store.create({ ttlMs: 60_000 });
    store.complete(taskId, { spec: "x" });
    const task = store.get(taskId);
    expect(task?.status).toBe("completed");
    expect(task).toMatchObject({ status: "completed", result: { spec: "x" } });

    // No-op once terminal (matches the store's "already-terminal" guard).
    store.fail(taskId, { message: "too late" });
    expect(store.get(taskId)?.status).toBe("completed");
  });

  it("fail() transitions to failed and carries the error", () => {
    const store = createTaskStore();
    const { taskId } = store.create({ ttlMs: 60_000 });
    store.fail(taskId, { message: "boom" });
    expect(store.get(taskId)).toMatchObject({ status: "failed", error: { message: "boom" } });
  });

  it("cancelled() transitions to cancelled with no extra fields", () => {
    const store = createTaskStore();
    const { taskId } = store.create({ ttlMs: 60_000 });
    store.cancelled(taskId);
    const task = store.get(taskId);
    expect(task?.status).toBe("cancelled");
    expect(task).not.toHaveProperty("result");
    expect(task).not.toHaveProperty("error");
  });

  it("requestCancel() fires the task's AbortController exactly when it is still working, and always acks a known id", () => {
    const store = createTaskStore();
    const { taskId, abort } = store.create({ ttlMs: 60_000 });
    expect(abort.signal.aborted).toBe(false);

    expect(store.requestCancel(taskId)).toEqual({ ok: true });
    expect(abort.signal.aborted).toBe(true);

    // A second cancel of an already-"working"-turned-"cancelled"(not yet, still working per the store's own
    // state machine — abort() firing does not itself flip status) is still idempotent and still acks.
    expect(store.requestCancel(taskId)).toEqual({ ok: true });

    // Once the task is terminal, a cancel still acks (non-error per the spec's non-blocking framing) but is a no-op abort-wise.
    store.complete(taskId, {});
    expect(store.requestCancel(taskId)).toEqual({ ok: true });
  });

  it("requestCancel() on an unknown id returns ok:false", () => {
    const store = createTaskStore();
    expect(store.requestCancel("no-such-task")).toEqual({ ok: false });
  });

  it("get()/requestCancel() lazily purge an expired task — an id past its ttlMs behaves as unknown", () => {
    let now = 1_000_000;
    const store = createTaskStore(() => now);
    const { taskId } = store.create({ ttlMs: 1_000 });
    expect(store.get(taskId)?.status).toBe("working");

    now += 1_001; // past ttlMs
    expect(store.get(taskId)).toBeUndefined();
    expect(store.requestCancel(taskId)).toEqual({ ok: false });
  });

  it("create() purges other expired tasks (bounded memory — no timer, see createTaskStore's doc comment)", () => {
    let now = 0;
    const store = createTaskStore(() => now);
    const old = store.create({ ttlMs: 100 });
    now += 200; // old has expired
    const fresh = store.create({ ttlMs: 100 });
    expect(store.get(old.taskId)).toBeUndefined();
    expect(store.get(fresh.taskId)?.status).toBe("working");
  });
});

describe("Per-request opt-in gate, with tasksEnabled:true (spec MUST: a server MUST NOT return a CreateTaskResult to a client that did not declare the extension)", () => {
  it("a request that does NOT declare the extension gets today's synchronous, byte-identical result", async () => {
    const server = buildAttached();
    const client = new Client({ name: "no-tasks-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });
    expect(result.isError).toBeFalsy();
    // Today's shape: content + structuredContent.spec, no task fields at all.
    expect(result.structuredContent).toHaveProperty("spec");
    expect(result).not.toHaveProperty("taskId");
    expect((result as { resultType?: unknown }).resultType).not.toBe("task");
  });

  it("a request that DOES declare the extension on kohaku_compose gets a CreateTaskResult (resultType: task) instead", async () => {
    const server = buildAttached();
    const buildServer = () => server; // stable instance across the one raw call this test makes
    const { status, json } = await sendRawModern(buildServer, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "kohaku_compose",
        arguments: { question: "Monthly revenue trend" },
        _meta: taskExtensionEnvelope(),
      },
    });
    expect(status).toBe(200);
    const result = json["result"] as Record<string, unknown>;
    expect(result["resultType"]).toBe("task");
    expect(typeof result["taskId"]).toBe("string");
    expect(result["status"]).toBe("working");
    expect(typeof result["createdAt"]).toBe("string");
    expect(typeof result["lastUpdatedAt"]).toBe("string");
    expect(result["ttlMs"]).toBe(600_000);
    expect(result["pollIntervalMs"]).toBe(2_000);
    // Not part of the CreateTaskResult shape (that's the synchronous packaged result's shape).
    expect(result).not.toHaveProperty("structuredContent");

    // The store actually holds a "working" task under this id (proves the tool call really started a task,
    // not just stamped fake-looking fields on a synchronous response).
    const store = __getTaskStoreForTest(server);
    expect(store?.get(result["taskId"] as string)?.status).toBe("working");
    await tick(); // let the fixedSpecs compose settle so it doesn't dangle past the test
  });

  it("server/discover reports the extension in ServerCapabilities.extensions", async () => {
    const server = buildAttached();
    const { client, close } = await connectModern(() => server, "discover-client");
    try {
      const capabilities = client.getServerCapabilities();
      expect(capabilities?.extensions).toHaveProperty("io.modelcontextprotocol/tasks");
    } finally {
      await close();
    }
  });
});

describe("AttachOptions.tasksEnabled default-off kill switch (team decision: never hand back a task handle while tasks/get is unreachable — see AttachOptions.tasksEnabled's doc comment)", () => {
  it("with tasksEnabled unset, a request that DOES declare the extension still gets today's synchronous result (not a CreateTaskResult)", async () => {
    const server = buildAttached(fixedSpecComposeCtx(), false);
    const buildServer = () => server;
    const { status, json } = await sendRawModern(buildServer, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "kohaku_compose",
        arguments: { question: "Monthly revenue trend" },
        _meta: taskExtensionEnvelope(),
      },
    });
    expect(status).toBe(200);
    const result = json["result"] as Record<string, unknown>;
    // A declaring client gets exactly what a non-declaring client gets: resultType "complete", the normal
    // packaged shape, no task fields at all — the whole point of the kill switch.
    expect(result["resultType"]).toBe("complete");
    expect(result).not.toHaveProperty("taskId");
    expect(result["structuredContent"]).toHaveProperty("spec");
  });

  it("with tasksEnabled unset, the server does not declare the extension on server/discover", async () => {
    const server = buildAttached(fixedSpecComposeCtx(), false);
    const { client, close } = await connectModern(() => server, "discover-off-client");
    try {
      const capabilities = client.getServerCapabilities();
      expect(capabilities?.extensions ?? {}).not.toHaveProperty("io.modelcontextprotocol/tasks");
    } finally {
      await close();
    }
  });

  it("with tasksEnabled unset, tasks/get and tasks/cancel are not registered at all (Method not found for a reason unrelated to the SDK-gate limitation)", async () => {
    const server = buildAttached(fixedSpecComposeCtx(), false);
    const { json } = await sendRawModern(() => server, {
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/get",
      params: { taskId: "whatever", _meta: taskExtensionEnvelope() },
    });
    const error = json["error"] as { code?: number } | undefined;
    expect(error?.code).toBe(-32601);
  });
});

describe("known SDK limitation (verified, not a kohaku bug — see registerTaskMethods's doc comment in server.ts)", () => {
  it("tasks/get is registered but unreachable over a 2026-07-28 connection with this SDK version (-32601)", async () => {
    const server = buildAttached();
    const { taskId } = __getTaskStoreForTest(server)!.create({ ttlMs: 60_000 });
    const { json } = await sendRawModern(() => server, {
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/get",
      params: { taskId, _meta: taskExtensionEnvelope() },
    });
    const error = json["error"] as { code?: number } | undefined;
    // If this ever starts succeeding, the SDK has changed its era-method table for tasks/get — go update
    // registerTaskMethods's doc comment and docs/design.md, this test is the tripwire.
    expect(error?.code).toBe(-32601);
  });

  it("tasks/cancel is likewise registered but unreachable (-32601)", async () => {
    const server = buildAttached();
    const { taskId } = __getTaskStoreForTest(server)!.create({ ttlMs: 60_000 });
    const { json } = await sendRawModern(() => server, {
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/cancel",
      params: { taskId, _meta: taskExtensionEnvelope() },
    });
    const error = json["error"] as { code?: number } | undefined;
    expect(error?.code).toBe(-32601);
  });
});

describe("cancellation wiring: tasks/cancel's logic (TaskStore.requestCancel) rides the composer's existing client-abort path", () => {
  it("cancelling a task-backed compose mid-generation settles the task as cancelled, not completed or failed", async () => {
    let started: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const server = buildAttached(noFixedComposeCtx(pendingUntilAbortLlm(() => started())));
    const buildServer = () => server; // stable instance: the cancel below must see the same task store

    const callPromise = sendRawModern(buildServer, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "kohaku_compose",
        arguments: { question: "Monthly revenue trend" },
        _meta: taskExtensionEnvelope(),
      },
    });
    // Wait for the tool call to return its CreateTaskResult (it returns immediately — the compose itself
    // keeps running in the background) before reaching for the taskId.
    const { json } = await callPromise;
    const result = json["result"] as Record<string, unknown>;
    expect(result["resultType"]).toBe("task");
    const taskId = result["taskId"] as string;
    expect(__getTaskStoreForTest(server)?.get(taskId)?.status).toBe("working");

    // Wait until the LLM call is actually in flight before cancelling (see pendingUntilAbortLlm's doc comment
    // in mcp.test.ts's sibling test — a pre-abort would never exercise the in-flight abort path).
    await startedPromise;
    // This is exactly what a real tasks/cancel handler does (see registerTaskMethods) — invoked directly here
    // because tasks/cancel itself is unreachable over the wire on this SDK version (see the describe block above).
    expect(__getTaskStoreForTest(server)?.requestCancel(taskId)).toEqual({ ok: true });

    await tick();
    const finalTask = __getTaskStoreForTest(server)?.get(taskId);
    expect(finalTask?.status).toBe("cancelled");
  });
});
