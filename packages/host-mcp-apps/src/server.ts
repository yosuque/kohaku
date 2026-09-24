import type { ComposeResult, TraceContext } from "@kohaku-ui/composer";
import * as hostCore from "@kohaku-ui/host-core";
import {
  canonicalStringify,
  finalizeIntent,
  type JsonObject,
  JsonObjectSchema,
  type Principal,
  type SessionContext,
  type UISpec,
  type VerifyRequest,
  type VerifyResult,
} from "@kohaku-ui/spec-core";
import {
  CLIENT_CAPABILITIES_META_KEY,
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type ServerContext,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { RENDERER_RESOURCE_CACHE_HINT } from "./cache-hints.js";
import { specToText } from "./fallback.js";
import { preresolveInitialData } from "./initial-data.js";
import {
  CAPABILITY_META_KEY,
  INITIAL_DATA_META_KEY,
  RENDERER_RESOURCE_URI,
  RESOURCE_MIME_TYPE,
  resourceUiMeta,
  toolUiMeta,
} from "./meta.js";

export { __setPreresolveTimeoutMsForTest, __setPreresolveTotalTimeoutMsForTest } from "./initial-data.js";

import { snapshotHtmlFor } from "./snapshot.js";
import {
  createTaskResult,
  createTaskStore,
  type DetailedTask,
  TASKS_EXTENSION_ID,
  type TaskStore,
} from "./tasks.js";
import type {
  AttachOptions,
  ComposeSource,
  IntentToolDef,
  McpHostDeps,
  ToolCallContext,
  ToolContext,
} from "./types.js";

// index.ts publicly re-exports these 3 (`export { ..., type AttachOptions, type IntentToolDef, type
// McpHostDeps } from "./server.js"`) — re-export them from here. ComposeSource and ToolContext stay
// module-internal (they are not part of the package's public surface).
export type { AttachOptions, IntentToolDef, McpHostDeps };

const ANONYMOUS: Principal = { id: "mcp-user", roles: ["user"] };

/**
 * Shared optional `locale` input for every UI-producing tool (compose / render_snapshot / intent
 * tools / event). The calling LLM sets it to the user's language so the composed UI (fixed-spec
 * titles, generated labels, L2 widget text) comes out localized — it maps onto the compose
 * session's `SessionContext.locale`, the same wire knob the REST profile carries as
 * `session.locale`. The name `locale` is reserved: intent params must not declare it.
 */
const LOCALE_INPUT = z
  .string()
  .optional()
  .describe(
    'Language tag of the user\'s environment (e.g. "ja" for Japanese, "en" for English). ' +
      "Set it to the language the user is conversing in; all user-visible text of the composed UI follows it. " +
      "Omit for English.",
  );

/** The compose session for one MCP tool call ("mcp-app" surface + the caller-provided locale). */
function mcpSession(locale: string | undefined, principal?: Principal): SessionContext {
  return {
    surface: "mcp-app",
    ...(locale != null ? { locale } : {}),
    ...(principal != null ? { principal } : {}),
  };
}

/** The compose "surface" recorded for every MCP-profile View Lineage entry (this profile's only surface). */
const MCP_APP_SURFACE = "mcp-app" as const;

/**
 * Builds this call's `ToolCallContext` from the attach-level `ToolContext` plus the `Principal` already
 * resolved for this specific call (via `ctx.principalOf(extra)`). A shallow spread is enough — `principal` is
 * the only field a call needs to add on top of the shared attach-level context (see `ToolCallContext`'s doc
 * comment in types.ts for why the two are kept as distinct types rather than mutating `principal` onto
 * `ToolContext` directly: it makes passing the un-resolved attach-level `ctx` into the compose pipeline a type
 * error instead of a latent "which principal did this call actually use" bug).
 */
function forCall(ctx: ToolContext, principal: Principal): ToolCallContext {
  return { ...ctx, principal };
}

/**
 * Consolidates every tool handler's access to the SDK-supplied per-call abort signal and JSON-RPC request id
 * into one place, so the 5 tool handlers below read `requestContextOf(extra)` uniformly rather than each
 * reaching into `extra.mcpReq` themselves. Under SDK v2 (`@modelcontextprotocol/server` 2.0.0, paired with
 * protocol version 2026-07-28's removal of protocol-level sessions), a tool handler's second argument is
 * `ServerContext`, which nests the per-request abort signal and JSON-RPC id under `mcpReq`
 * (`extra.mcpReq.signal` / `extra.mcpReq.id`); this function is a thin projection of that shape.
 *
 * Named `abort` (not `signal`) on the returned object so `{ ...requestContextOf(extra), locale, traceContext:
 * traceContextOf(extra) }` is directly a `ComposeCallContext` — every compose-family tool handler builds its
 * `ComposeCallContext` this way (see that type's doc comment).
 */
function requestContextOf(extra: ServerContext): { abort: AbortSignal; requestId: string } {
  return {
    abort: extra.mcpReq.signal,
    requestId: String(extra.mcpReq.id),
  };
}

/**
 * The compose-pipeline call context: everything about a single tool call (beyond the already-resolved
 * `ToolCallContext.principal`) that composeAndAudit / composeAndPackage / startComposeTask / buildSnapshot /
 * composeForTool need to thread through to host-core's composeWithFixation, bundled into one options bag
 * instead of separate positional parameters. Every call site builds one via `{ ...requestContextOf(extra),
 * locale, traceContext: traceContextOf(extra) }` (requestContextOf's returned `{abort, requestId}` already
 * matches this type's field names by construction, so the spread needs only `locale` and `traceContext`
 * added).
 */
interface ComposeCallContext {
  locale?: string;
  abort?: AbortSignal;
  requestId?: string;
  traceContext?: TraceContext;
}

/**
 * The same `_meta.traceparent` (+ `_meta.tracestate`, when present) as a `ComposeOptions.traceContext` value
 * (host-core's shared parseTraceContext, also used by host-rest's `traceparent` request-header counterpart),
 * so an OTel observer (see @kohaku-ui/otel) can record the compose span as a child of the caller's own
 * trace. Fail-open: undefined on a missing/malformed traceparent (composeForTool then simply omits it).
 * Reads via the SDK's own `TRACEPARENT_META_KEY` / `TRACESTATE_META_KEY` constants rather than the hand-written
 * `"traceparent"` / `"tracestate"` literals (same values — a drop-in tidy). traceparent/tracestate are ordinary
 * `_meta` keys, not part of the 2026-07-28 per-request envelope (`extra.mcpReq.envelope`, which carries only
 * protocol version / client info / client capabilities / log level), so they still arrive on `extra.mcpReq._meta`.
 */
function traceContextOf(extra: ServerContext): TraceContext | undefined {
  return hostCore.parseTraceContext(
    extra.mcpReq._meta?.[TRACEPARENT_META_KEY],
    extra.mcpReq._meta?.[TRACESTATE_META_KEY],
  );
}

/**
 * Whether THIS SPECIFIC request declared the MCP Tasks extension (io.modelcontextprotocol/tasks,
 * 2026-07-28 dated-stable) via its per-request `_meta` envelope claim
 * (`_meta["io.modelcontextprotocol/clientCapabilities"].extensions["io.modelcontextprotocol/tasks"]`).
 * This is a spec MUST, not a style choice: a server MUST NOT return a `CreateTaskResult` to a client that
 * did not declare the extension on that request — so every task-capable tool handler below gates on this
 * before ever considering an async/task response, and executes exactly as today (byte-identical) when it
 * is absent.
 *
 * Reads via `extra.mcpReq.envelope` — the 2026-07-28 per-request envelope, with the reserved
 * `io.modelcontextprotocol/*` keys already lifted out of `_meta` (see `traceContextOf`'s sibling doc for
 * the analogous `_meta` read). The SDK's own typing for this field (`ServerContext['mcpReq']['envelope']:
 * Partial<RequestMetaEnvelope>`) is an intentionally loose `Partial<{}>` at this SDK version — the SDK
 * ships no runtime for the tasks extension at all (see tasks.ts's module doc) — so this reads it via the
 * same loose-cast pattern `traceContextOf` already uses for wire-only `_meta` fields, rather than a typed
 * property access the compiler would reject.
 */
function taskExtensionDeclared(extra: ServerContext): boolean {
  const envelope = extra.mcpReq.envelope as
    | Partial<Record<string, { extensions?: Record<string, unknown> }>>
    | undefined;
  return envelope?.[CLIENT_CAPABILITIES_META_KEY]?.extensions?.[TASKS_EXTENSION_ID] !== undefined;
}

/**
 * Whether a task-capable tool call should actually take the async/task branch for THIS request: the
 * product-level `AttachOptions.tasksEnabled` kill switch (default off) AND the per-request opt-in
 * (`taskExtensionDeclared`) both have to hold. `tasksEnabled` exists because `tasks/get` is currently
 * unreachable over the wire on the installed SDK (see `registerTaskMethods`'s doc comment) — while that is
 * true, handing back a `CreateTaskResult` would give a declaring client a task handle it can never poll,
 * which is worse than no handle at all, so the default keeps every compose-family tool synchronous
 * regardless of what a request declares. See `AttachOptions.tasksEnabled`'s own doc comment for the full
 * reasoning and how to tell when it is safe to flip on.
 */
function taskCapable(ctx: ToolContext, extra: ServerContext): boolean {
  return ctx.options.tasksEnabled === true && taskExtensionDeclared(extra);
}

/**
 * compose + audit record (fail-open). The identically-shaped processing at the top of composeAndPackage / buildSnapshot.
 * Only the endpoint name differs; an audit failure is reported to the observation hook and the result returns normally.
 * afterCompose runs immediately before the audit record (preserving composeAndPackage's capability-issuance ordering).
 *
 * Audit recording is symmetric with the REST profile: when `deps.recorder` (ViewRecorder) is wired, both
 * `composed` and `fallback` (host-core's recordViewFallback, shared with REST's recordFallbackIfAny) are
 * recorded here, matching REST's deliverComposed/finishStream. When only the legacy `deps.onComposed` is
 * wired, that alone is called (no fallback recording — the old, narrower contract). `recorder` takes priority
 * when both are present.
 *
 * `abort`, when passed, propagates the tool call's cancellation (SDK's `extra.mcpReq.signal`) into composeForTool ->
 * composeWithFixation -> the composer's L1/L2 LLM generation, so a cancelled MCP tool call stops doing
 * generation work the caller has already given up on (parity with the REST profile's abort wiring via
 * `c.req.raw.signal`).
 *
 * `requestId`, when passed (the SDK's `extra.mcpReq.id` — the JSON-RPC id of the tool call), is forwarded
 * into composeForTool -> composeWithFixation as both the fixation self-heal correlation id (already
 * threaded through resolveFixatedResult) and, additively, ComposeOptions.correlationId, so a
 * degraded/failed delivery's observer.onError call and ComposeTrace can be tied back to this tool call the
 * same way host-rest ties them back to X-Request-Id.
 *
 * `traceContext` (from `_meta.traceparent` via traceContextOf), when passed, is forwarded the same way as
 * ComposeOptions.traceContext (additive/opt-in, see composeForTool's doc comment).
 */
async function composeAndAudit(
  ctx: ToolCallContext,
  input: ComposeSource,
  endpoint: string,
  options?: ComposeCallContext & { afterCompose?: (result: ComposeResult) => Promise<void> },
): Promise<ComposeResult> {
  const result = await composeForTool(ctx, input, options);
  if (options?.afterCompose != null) await options.afterCompose(result);
  // The audit record is cancelled-aware and fail-open (host-core's recordComposedResult, shared with the REST
  // profile's deliverComposed/finishStream): a recording failure is swallowed so it does not drag down UI
  // delivery (including a cached Spec), and the failure is reported to the observation hook (onError) while
  // the result returns normally. A cancelled compose (the caller's abort fired) is not a generation failure
  // and observer.onError already received phase:"cancelled" from the composer — recordComposedResult skips
  // the audit record so a client disconnect/timeout does not inflate audit counts.
  await hostCore.recordComposedResult(
    result,
    async () => {
      if (ctx.deps.recorder != null) {
        await ctx.deps.recorder.composed({
          spec: result.spec,
          trace: result.trace,
          surface: MCP_APP_SURFACE,
        });
        await hostCore.recordViewFallback(ctx.deps.recorder, result.spec, { surface: MCP_APP_SURFACE });
      } else {
        await ctx.deps.onComposed?.(result.spec, result.trace);
      }
    },
    (e) => reportMcpError(ctx.deps, endpoint, e),
  );
  return result;
}

async function composeAndPackage(
  ctx: ToolCallContext,
  input: ComposeSource,
  callCtx?: ComposeCallContext,
  // Optional peek at the raw ComposeResult right after composeAndAudit resolves, before packaging. The only
  // consumer today is startComposeTask below, which needs `result.trace.cancelled` to tell a genuine
  // tasks/cancel-driven cancellation apart from an ordinary completion/fallback when deciding which status
  // to settle the task at — composeAndPackage's own return value (the packaged tool result) does not carry
  // that distinction. Unused by every synchronous caller, so this is purely additive.
  onComposeResult?: (result: ComposeResult) => void,
) {
  // The compose → capability → audit-record (fail-open) order is intentional; do not reorder.
  let capability!: string;
  const result = await composeAndAudit(ctx, input, "compose", {
    ...callCtx,
    afterCompose: async (composed) => {
      // host-core's issueSpecCapabilitySafely applies the scope-collection rule (SPEC §5 A1;
      // collectCapabilityScopes is the single source of truth), shared with the REST profile so both profiles
      // agree on the issuance rule. Without read enumeration of bind variants, a bind switch (state.set →
      // effective ref re-resolution) is rejected by resolve_binding's verify (exact match) and the A1
      // cross-filter fails on the MCP surface only. Without write, ${prefix}_action's verify (write) does not
      // pass, and form submission / action.button always returns 403 on the MCP surface.
      //
      // Write scopes are additionally restricted to DomainPort.listOperations() names (hardening against a
      // hallucinated/injected action.invoke action name becoming a bearer write scope), symmetric with the
      // REST profile's issueSpecCapability wrapper. If listOperations rejects, issueSpecCapabilitySafely falls
      // back to an empty allowed set (fail-closed for writes; delivery proceeds) and reports the rejection.
      capability = await hostCore.issueSpecCapabilitySafely(
        ctx.deps.authz,
        ctx.principal,
        composed.spec,
        ctx.allowedActions,
        (e) => reportMcpError(ctx.deps, "compose.capability", e),
        undefined,
      );
    },
  });
  onComposeResult?.(result);
  // Preresolve the initial data on the server side and co-embed it in the tool result's _meta. This makes the
  // initial display appear fully even if the host's app-originated tool call (kohaku_resolve_binding) is broken.
  // Putting it in _meta rather than structuredContent is the key point (_meta does not enter the model's context and is
  // transferred only to the widget = upholding the "bulk data never passes through the model" principle). kohaku_event also
  // goes through this function, so it is co-embedded automatically (which is correct).
  // The capability token is co-embedded in _meta for the same reason (see CAPABILITY_META_KEY's doc comment):
  // structuredContent enters the model's context, so a bearer write token must never ride there.
  // `resolved` is the full pre-budget Map of every ref this call already resolved — handed to snapshotHtmlFor
  // below so the legacyUiResource co-emission (which needs the identical ref set) does not re-invoke
  // domain.invoke for refs already resolved here.
  const { data: initialData, resolved: preresolvedRefs } = await preresolveInitialData(result.spec, ctx);
  // content[0] is always the text fallback (MCPAPP-FBK-001). The legacy UIResource comes after.
  const content: Array<
    | { type: "text"; text: string }
    | { type: "resource"; resource: { uri: string; mimeType: string; text: string } }
  > = [{ type: "text", text: specToText(result.spec) }];
  if (ctx.options.legacyUiResource === true) {
    // Static-snapshot co-emission for mcp-ui legacy hosts. An assembly failure (unbuilt renderer, data
    // resolution failure) is swallowed, reported to the observation hook, and dropped to a normal response without the
    // co-emission (fail-open — the legacy-compat add-on must not drag down the actual delivery).
    try {
      content.push({
        type: "resource",
        resource: {
          uri: `ui://kohaku/view/${result.spec.intent.hash}`,
          mimeType: "text/html",
          text: await snapshotHtmlFor(ctx, result, preresolvedRefs),
        },
      });
    } catch (e) {
      await reportMcpError(ctx.deps, "compose.legacyUiResource", e);
    }
  }
  return {
    content,
    // capability is deliberately NOT included here (see CAPABILITY_META_KEY's doc comment): structuredContent
    // is model-visible, and a bearer write token must never enter the model's context.
    structuredContent: { spec: result.spec } as unknown as Record<string, unknown>,
    _meta: {
      ...toolUiMeta({ resourceUri: RENDERER_RESOURCE_URI }),
      [INITIAL_DATA_META_KEY]: initialData,
      [CAPABILITY_META_KEY]: capability,
    },
  };
}

/**
 * Default `ttlMs`/`pollIntervalMs` for a compose-backed task. `ttlMs` deliberately mirrors the 600s
 * default this repo already uses for capability issuance (host-core's `issueCapabilityForSpec`) — the same
 * kind of "how long is a single compose's byproduct worth keeping around" call, and a generous-but-bounded
 * backstop rather than a measured p99: `ComposeBudget.deadlineMs` is unset by default (see docs/design.md's
 * compose-wide-deadline section), so L1 + repair + L2 has no operator-configured hard ceiling to derive a
 * tighter number from. `pollIntervalMs` trades "feels responsive" against "don't hammer tasks/get" for an
 * operation measured in the tens of seconds, not milliseconds.
 */
const COMPOSE_TASK_TTL_MS = 600_000;
const COMPOSE_TASK_POLL_INTERVAL_MS = 2_000;

/**
 * Starts a compose (any `ComposeSource`) as a background task instead of awaiting it inline, returning the
 * `CreateTaskResult` describing the just-created "working" task. Only called after `taskExtensionDeclared`
 * has already gated the request — see the compose-family tool handlers below.
 *
 * Cancellation: `tasks/cancel` (see `registerTaskMethods`) fires the same `AbortController` the task store
 * hands back from `create`, which rides straight into `composeAndPackage`'s `abort` parameter — the exact
 * same client-abort path `${prefix}_compose`'s synchronous branch already wires today (see
 * `composeAndAudit`'s doc comment and docs/design.md's "Client aborts are distinguished from generation
 * fallbacks"). This is deliberately the SAME cancellation concept, not a second one: a `tasks/cancel` IS a
 * client abort. `onComposeResult` observes `result.trace.cancelled` to tell a genuine cancellation apart
 * from an ordinary completion or generation fallback when deciding which terminal status to settle the
 * task at (composeWithFixation never throws for an aborted call — it degrades to the same fallback Spec
 * any other L1/L2 failure would, just marked `trace.cancelled: true` — so this is the only reliable signal).
 *
 * The compose is deliberately NOT awaited here — it runs to completion (or cancellation, or failure) in the
 * background, and the tool call returns immediately with the task descriptor.
 */
function startComposeTask(
  ctx: ToolCallContext,
  input: ComposeSource,
  callCtx: ComposeCallContext,
): { resultType: "task" } & DetailedTask {
  const { taskId, abort, task } = ctx.tasks.create({
    ttlMs: COMPOSE_TASK_TTL_MS,
    pollIntervalMs: COMPOSE_TASK_POLL_INTERVAL_MS,
  });
  let cancelled = false;
  // The task's own AbortController (not the synchronous tool call's own abort signal, which is meaningless
  // once the tool call has already returned a CreateTaskResult) drives cancellation here — see this
  // function's doc comment on tasks/cancel wiring into the same client-abort path.
  void composeAndPackage(ctx, input, { ...callCtx, abort: abort.signal }, (result) => {
    cancelled = result.trace.cancelled === true;
  })
    .then((packaged) => {
      if (cancelled) ctx.tasks.cancelled(taskId);
      else ctx.tasks.complete(taskId, packaged as unknown as JsonObject);
    })
    .catch((e) => {
      void reportMcpError(ctx.deps, "tasks.compose", e);
      ctx.tasks.fail(taskId, { message: hostCore.errorMessage(e) });
    });
  return createTaskResult(task);
}

/**
 * Assembles the body of the self-contained snapshot HTML. Records audit symmetrically with the compose surface,
 * preresolves each data's initial $ref + all bind variants in the Spec via domain.invoke, and embeds them into the shared
 * renderer's #kohaku-snapshot as {spec, data} (landing the reference-passing right here).
 */
async function buildSnapshot(
  ctx: ToolCallContext,
  input: ComposeSource,
  callCtx?: ComposeCallContext,
): Promise<{ spec: UISpec; html: string }> {
  // The audit record is fail-open symmetrically with the existing compose: a recording failure does not drag down HTML generation.
  const result = await composeAndAudit(ctx, input, "render_snapshot", callCtx);
  // HTML assembly is shared with the legacy UIResource co-emission path via snapshotHtmlFor (bounded
  // concurrency + an overall deadline, see snapshotHtmlFor's doc). Here the snapshot is the deliverable itself
  // (no other resolution pass to share with), so a resolution failure or timeout is propagated rather than
  // swallowed (do not emit incomplete HTML).
  const html = await snapshotHtmlFor(ctx, result);
  return { spec: result.spec, html };
}

/** Registers the `ui://kohaku/renderer.html` resource (the shared renderer, text/html;profile=mcp-app). */
function registerRendererResource(ctx: ToolContext): void {
  ctx.server.registerResource(
    "kohaku-renderer",
    RENDERER_RESOURCE_URI,
    {
      title: "kohaku shared renderer",
      description: "Shared renderer that renders the UI Spec with the same rendering code as the Web",
      mimeType: RESOURCE_MIME_TYPE,
      // Resource-side UI metadata (SEP-1865). Explicitly declares csp as an empty allowlist to tell the host
      // "no external origin needed" (the static default that appears in resources/list; the same declaration on
      // the contents side takes precedence per spec).
      _meta: resourceUiMeta(),
      // MCP 2026-07-28 (SEP-2549): resources/read freshness hint for this resource specifically (this
      // overrides ServerOptions.cacheHints["resources/read"] field-by-field, which this package never
      // configures — see RENDERER_RESOURCE_CACHE_HINT's doc comment for the reasoning and TS/Python asymmetry).
      cacheHint: ctx.options.rendererResourceCacheHint ?? RENDERER_RESOURCE_CACHE_HINT,
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: RESOURCE_MIME_TYPE,
          text: await ctx.getRendererHtml(),
          // The contents-side `_meta.ui` takes precedence over the listing side (SEP-1865). We put the same value on both.
          _meta: resourceUiMeta(),
        },
      ],
    }),
  );
}

/**
 * Casts a task-branch return value (`startComposeTask`'s `CreateTaskResult`) to line up, for the type
 * checker only, with `composeAndPackage`'s inferred return type — used at each task-capable tool's
 * `if (taskCapable(ctx, extra)) return …` branch below instead of giving that branch its own precise
 * type. Both `safeTool`'s own `T` and `registerTool`'s `cb` parameter are inferred generics; once the two
 * branches of an if/return inside that callback present TS with genuinely different literal shapes (or an
 * explicit named union type standing in for them), the installed TypeScript 7 compiler was observed to
 * mis-resolve `registerTool`'s overload set entirely (rejecting the `z.object(...)` `inputSchema` argument
 * against the *deprecated* raw-`ZodRawShape` overload instead of the intended `StandardSchemaWithJSON` one)
 * — reproducible even after extracting the branching into its own separately-typed function. Making both
 * branches present the identical (if fictitious) type via this cast keeps the inference exactly as simple
 * as it was before either branch existed, and is sound in practice: `safeTool` only ever spreads its `fn()`
 * result and re-stamps `resultType`, so the precise shape was never actually load-bearing there.
 */
function asComposePackage<T>(value: unknown): T {
  return value as T;
}

/**
 * Registers `${prefix}_compose` (model-visible): natural language → UI.
 *
 * Task-capable when `AttachOptions.tasksEnabled` is on (see `taskCapable` / `startComposeTask`): this is the
 * motivating case for the MCP Tasks extension in this profile — L2 free-form generation is measured in the
 * tens of seconds (docs/design.md §7's outputBudgetFactor=3 note) and, without an operator-configured
 * `ComposeBudget.deadlineMs`, has no upper bound, so it blocks the calling tool call for however long
 * L1→repair→L2 takes. A client that declared the extension on this specific request gets a `CreateTaskResult`
 * back immediately and polls `tasks/get` instead of holding the connection open — **but only once
 * `tasksEnabled` is on**; by default this executes synchronously regardless of what a request declares (see
 * `AttachOptions.tasksEnabled`'s doc comment for why: `tasks/get` is currently unreachable on the installed SDK).
 */
function registerComposeTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    `${ctx.prefix}_compose`,
    {
      title: "Compose a UI for business data",
      description:
        "Converts a natural-language question into a normalized Intent and composes a declarative UI Spec. " +
        "The result includes both a text summary and a structured Spec for UI-capable hosts.",
      inputSchema: z.object({
        question: z.string().min(1).describe("Natural-language question (Japanese supported)"),
        locale: LOCALE_INPUT,
      }),
      _meta: toolUiMeta({ resourceUri: RENDERER_RESOURCE_URI, visibility: ["model"] }),
    },
    async ({ question, locale }, extra) =>
      safeTool(ctx.deps, `${ctx.prefix}_compose`, async () => {
        const call = forCall(ctx, await ctx.principalOf(extra));
        const callCtx: ComposeCallContext = {
          ...requestContextOf(extra),
          locale,
          traceContext: traceContextOf(extra),
        };
        const input: ComposeSource = { kind: "nl", text: question };
        if (taskCapable(ctx, extra)) {
          return asComposePackage<ReturnType<typeof composeAndPackage>>(
            Promise.resolve(startComposeTask(call, input, callCtx)),
          );
        }
        return composeAndPackage(call, input, callCtx);
      }),
  );
}

/**
 * Registers `${prefix}_render_snapshot` (model-visible): self-contained snapshot HTML for UI-incapable
 * hosts. Does not register the tool if snapshotWriter is unwired (exposing it without a write hook
 * is pointless).
 */
function registerRenderSnapshotTool(ctx: ToolContext): void {
  if (ctx.options.snapshotWriter == null) return;
  const snapshotWriter = ctx.options.snapshotWriter;
  ctx.server.registerTool(
    `${ctx.prefix}_render_snapshot`,
    {
      title: "Generate self-contained snapshot HTML",
      description:
        "For UI-incapable hosts (CLI, etc.), generates self-contained HTML rendered with the same shared renderer as the Web. " +
        "Since it embeds the UI Spec and resolved data in a single file, use the returned URL's or local path's HTML " +
        "directly for display (if the model builds its own UI from the tool result, its rendering will diverge from the Web).",
      inputSchema: z.object({
        question: z.string().min(1).describe("Natural-language question (Japanese supported)"),
        locale: LOCALE_INPUT,
      }),
      // This tool generates an HTML file rather than opening an iframe view, so it has no resourceUri.
      _meta: toolUiMeta({ visibility: ["model"] }),
    },
    async ({ question, locale }, extra) =>
      safeTool(ctx.deps, `${ctx.prefix}_render_snapshot`, async () => {
        const call = forCall(ctx, await ctx.principalOf(extra));
        const { spec, html } = await buildSnapshot(
          call,
          { kind: "nl", text: question },
          {
            ...requestContextOf(extra),
            locale,
            traceContext: traceContextOf(extra),
          },
        );
        // The file name is derived from the intent hash (identical displays coalesce into the same file and do not collide).
        // The return value is a locator = local path or public URL (branching in snapshotWriter's implementation = host responsibility).
        const locator = await snapshotWriter(`snapshot-${spec.intent.hash}.html`, html);
        // Do not return the HTML body (about 1MB) to the model. Put only the locator (URL / path) and the specToText summary into content.
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Generated self-contained snapshot HTML.\n" +
                `Snapshot: ${locator}\n` +
                "Use this URL's or local path's HTML directly for display (open it in a browser). Do not build your own UI.\n\n" +
                specToText(spec),
            },
          ],
          // The structuredContent shape is unchanged ({ path, spec }). path is a local path or public URL
          // (depending on snapshotWriter's implementation; for remote MCP, the URL that http.ts serves statically under /snapshots).
          structuredContent: { path: locator, spec } as unknown as Record<string, unknown>,
        };
      }),
  );
}

/**
 * Registers one model-visible tool per catalog entry in `options.intentTools` (structured Intent → UI).
 * Task-capable on the same basis as `${prefix}_compose` above, including the `AttachOptions.tasksEnabled`
 * gate (same `composeAndPackage` → L1/L2 pipeline, just a structured Intent instead of an NL question as
 * the ComposeSource).
 */
function registerIntentTools(ctx: ToolContext): void {
  for (const tool of ctx.options.intentTools ?? []) {
    // `locale` is a reserved tool argument (the shared language input below), so an intent that
    // declares a param of that name would be silently shadowed — reject it deterministically,
    // in the same style as the tool-name collision check in intentToolsFromCatalog.
    if ("locale" in tool.paramsShape) {
      throw new Error(
        `Intent tool "${tool.name}" declares a param named "locale", which is reserved for the shared language input`,
      );
    }
    ctx.server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: z.object({ ...tool.paramsShape, locale: LOCALE_INPUT }),
        _meta: toolUiMeta({ resourceUri: RENDERER_RESOURCE_URI, visibility: ["model"] }),
      },
      async (args, extra) =>
        safeTool(ctx.deps, tool.name, async () => {
          const call = forCall(ctx, await ctx.principalOf(extra));
          // Pull the shared language input out before it reaches the intent params (it must not
          // pollute the canonical intent / intent hash).
          const { locale, ...params } = args as JsonObject & { locale?: string };
          const callCtx: ComposeCallContext = {
            ...requestContextOf(extra),
            locale,
            traceContext: traceContextOf(extra),
          };
          const input: ComposeSource = { kind: "intent", intent: tool.toIntent(params as JsonObject) };
          if (taskCapable(ctx, extra)) {
            return asComposePackage<ReturnType<typeof composeAndPackage>>(
              Promise.resolve(startComposeTask(call, input, callCtx)),
            );
          }
          return composeAndPackage(call, input, callCtx);
        }),
    );
  }
}

/** Registers `${prefix}_resolve_binding` (app-only): data resolution from the iframe (the landing point of reference-passing). */
function registerResolveBindingTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    `${ctx.prefix}_resolve_binding`,
    {
      description: "(app-only) Resolves a Spec's $ref with a capability and returns bulk data",
      inputSchema: z.object({ ref: z.string(), capability: z.string() }),
      _meta: toolUiMeta({ visibility: ["app"] }),
    },
    async ({ ref, capability }, extra) =>
      // parseInvokableRef / domain.invoke failures also become tool errors rather than RPC exceptions (symmetric with REST's 400).
      safeTool(ctx.deps, `${ctx.prefix}_resolve_binding`, async () => {
        // Resolved once for this call (see McpHostDeps.resolvePrincipal's doc comment) — used only as the
        // fallback below when the AuthzPort's verify does not itself return a principal.
        const principal = await ctx.principalOf(extra);
        // Server-side paging/sorting: as on the REST surface, verify the capability against base (with reserved
        // parameters removed), and merge the reserved parameters into domain.invoke (the `_` namespace convention).
        // Unknown `_` keys are rejected as on the REST surface (to prevent changing the data range via unauthorized parameters).
        // parseInvokableRef (host-core, shared with REST's /binding/resolve and this package's initial-data
        // preresolution) does the pure parse/merge; the verify step and error mapping stay here.
        const parsed = hostCore.parseInvokableRef(ref, ctx.deps.querySource);
        if (parsed.kind === "source_mismatch") {
          return toolError(`unknown query source "${parsed.source}"`);
        }
        const { base, params } = parsed.ref;
        const verdict = await verifyCapability(ctx.deps, `${ctx.prefix}_resolve_binding`, capability, {
          kind: "read",
          ref: base.raw,
        });
        if ("isError" in verdict) return verdict;
        if (!verdict.ok) {
          return toolError(`capability denied: ${verdict.reason ?? ""}`);
        }
        const data = await ctx.deps.domain.invoke(base.path, params, {
          principal: verdict.principal ?? principal,
          capability,
        });
        const rows = (data as { rows?: unknown[] }).rows?.length ?? 0;
        return {
          content: [{ type: "text" as const, text: `resolved ${rows} rows from ${base.raw}` }],
          structuredContent: { data } as Record<string, unknown>,
        };
      }),
  );
}

/** Registers `${prefix}_event` (app-only): component event → Intent delta → recomposition. */
function registerEventTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    `${ctx.prefix}_event`,
    {
      description: "(app-only) Recomposes a component event as an Intent delta",
      inputSchema: z.object({
        // JsonObjectSchema (not a bare z.record) caps nesting depth the same way kohaku_action's own
        // `payload` already does (host-rest's ActionBodySchema counterpart), guarding the recursive
        // canonical-JSON serialization (intent-hash computation) and lineage persistence downstream of
        // these fields against a pathologically deep but otherwise well-formed payload.
        intent: z.object({ canonical: z.string(), params: JsonObjectSchema }),
        on: z.string(),
        payload: JsonObjectSchema.default({}),
        locale: LOCALE_INPUT,
      }),
      _meta: toolUiMeta({ resourceUri: RENDERER_RESOURCE_URI, visibility: ["app"] }),
    },
    async ({ intent, on, payload, locale }, extra) =>
      safeTool(ctx.deps, `${ctx.prefix}_event`, async () => {
        const call = forCall(ctx, await ctx.principalOf(extra));
        const current = await finalizeIntent({
          canonical: intent.canonical,
          params: intent.params as JsonObject,
        });
        // Intent resolution via host-core's resolveIntent (shared with the REST profile's /events GUI-delta
        // site), rather than a local semantic.normalize copy — keeps the "gui" normalization behavior (and
        // its session, including the attached principal) in one place.
        const { intent: resolved } = await hostCore.resolveIntent(
          ctx.deps.compose.semantic,
          { kind: "gui", current, action: on, params: payload as JsonObject },
          mcpSession(locale, call.principal),
        );
        // Record view.interacted symmetrically with the REST surface's /events (which records it before
        // recomposing, via KohakuHostDeps.recorder). Fail-open: a recording failure must not block
        // recomposition, and is reported to the observation hook instead.
        if (ctx.deps.recorder != null) {
          await hostCore.failOpen(
            () =>
              ctx.deps.recorder!.interacted({
                intentHash: current.hash,
                componentId: on.split(".")[0]!,
                on,
                payload: payload as JsonObject,
                surface: MCP_APP_SURFACE,
              }),
            (e) => reportMcpError(ctx.deps, `${ctx.prefix}_event`, e),
          );
        }
        // Pass the already-resolved CanonicalIntent through as-is ("canonical" kind) rather than
        // re-destructuring it into a plain `{canonical, params}` literal — composeForTool then skips a
        // redundant second normalize+finalize pass over the same Intent (see ComposeSource's doc comment).
        return composeAndPackage(
          call,
          { kind: "canonical", intent: resolved },
          {
            ...requestContextOf(extra),
            locale,
            traceContext: traceContextOf(extra),
          },
        );
      }),
  );
}

/**
 * Upper bound (canonical-JSON, UTF-8 bytes) on a `${prefix}_action` payload. `OperationDescriptor.paramsSchema`
 * validation itself is a follow-up (no JSON Schema validator such as Ajv is wired into this repo yet) — this
 * is a coarse defense-in-depth cap against an oversized write, not a shape check.
 */
const MAX_ACTION_PAYLOAD_BYTES = 64 * 1024;

/**
 * Registers `${prefix}_action` (app-only): direct write path (presentForm submit / action.button).
 * Symmetric with the REST surface's /binding/action. Callable only from the iframe (widget) (visibility ["app"]).
 * On hosts where ext-apps' app-originated tools/call is broken it may fail, but that failure surfaces in
 * useInvokeAction's failed display (the initial display is separately guaranteed by the _meta co-embedded data).
 *
 * Since the compose-issued capability now rides `_meta` rather than model-visible `structuredContent` (see
 * CAPABILITY_META_KEY), a host that still forwards `_meta` to the model, or a prompt-injected instruction that
 * otherwise obtains a capability, could still try to drive this tool with an arbitrary action/payload. Two
 * checks add defense in depth on top of the existing capability `verify`: `action` must be one of the
 * DomainPort's `listOperations()` names (the same source `issueCapabilityForSpec`'s write-scope filter already
 * uses — host-core's `createAllowedActions`), and `payload` is capped at `MAX_ACTION_PAYLOAD_BYTES`.
 * Full argument-shape validation via `OperationDescriptor.paramsSchema` is a follow-up.
 */
function registerActionTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    `${ctx.prefix}_action`,
    {
      description:
        "(app-only) Executes a declared action with a capability and returns a result with a side-effect declaration",
      inputSchema: z.object({
        action: z.string(),
        // JsonObjectSchema (not a bare z.record) caps nesting depth the same way host-rest's ActionBodySchema
        // does, for the same reason (canonicalStringify / persistence downstream of an unbounded payload).
        payload: JsonObjectSchema.default({}),
        capability: z.string(),
      }),
      // This tool executes a write rather than opening an iframe view, so it has no resourceUri (same as resolve_binding).
      _meta: toolUiMeta({ visibility: ["app"] }),
    },
    async ({ action, payload, capability }, extra) =>
      safeTool(ctx.deps, `${ctx.prefix}_action`, async () => {
        // DomainPort.invoke carries no cancellation primitive (unlike the compose path's L1/L2 LLM calls), so
        // there is nothing to propagate the abort signal into once the write is under way — but a call already
        // cancelled by the time it reaches the handler must not still perform the write (a client that has
        // given up should not have its abandoned request silently take effect).
        if (requestContextOf(extra).abort.aborted) {
          return toolError("cancelled");
        }
        // Resolved once for this call (see McpHostDeps.resolvePrincipal's doc comment) — used only as the
        // fallback below when the AuthzPort's verify does not itself return a principal.
        const principal = await ctx.principalOf(extra);
        // Reject an action name the DomainPort does not expose before even attempting capability verification
        // (see this function's doc comment). Fail-closed on a listOperations() rejection too — every action is
        // "unknown" for this call, and the failure is reported to the observability hook.
        let allowed: ReadonlySet<string>;
        try {
          allowed = await ctx.allowedActions();
        } catch (e) {
          await reportMcpError(ctx.deps, `${ctx.prefix}_action.allowedActions`, e);
          allowed = new Set();
        }
        if (!allowed.has(action)) {
          return toolError("unknown action");
        }
        const payloadBytes = new TextEncoder().encode(canonicalStringify(payload)).length;
        if (payloadBytes > MAX_ACTION_PAYLOAD_BYTES) {
          return toolError(`payload exceeds the maximum size (${MAX_ACTION_PAYLOAD_BYTES} bytes)`);
        }
        // Verify with the write scope, symmetric with the REST surface (/binding/action). A denial becomes a tool error rather than an RPC exception.
        const verdict = await verifyCapability(ctx.deps, `${ctx.prefix}_action`, capability, {
          kind: "write",
          ref: action,
        });
        if ("isError" in verdict) return verdict;
        if (!verdict.ok) {
          return toolError(`capability denied: ${verdict.reason ?? ""}`);
        }
        const result = await ctx.deps.domain.invoke(action, payload as JsonObject, {
          principal: verdict.principal ?? principal,
          capability,
        });
        // The write is already committed; a side-effect-declaration failure is fail-open — see host-core's applyActionEffects.
        // structuredContent is { result, invalidates?, refVersions? } (the shape data-binding's parseActionResult
        // reads directly; symmetric with the REST surface's /binding/action). When unwired, { result } only =
        // backward-compatible.
        const effects = await hostCore.applyActionEffects(
          ctx.deps.actionEffects,
          action,
          payload as JsonObject,
          result,
          (e) => reportMcpError(ctx.deps, `${ctx.prefix}_action.effects`, e),
        );
        return {
          content: [{ type: "text" as const, text: `Executed action ${action}` }],
          structuredContent: effects as unknown as Record<string, unknown>,
        };
      }),
  );
}

/**
 * The MCP Apps profile of the Kohaku Protocol (SEP-1865).
 * - kohaku_compose (model-visible): NL → the same Composition Service → Spec + text fallback
 * - kohaku_resolve_binding / kohaku_event (app-only): callable only from the iframe.
 *   Bulk data never passes through the model's context (the reference-passing principle, enforced on the MCP surface too)
 * - ui://kohaku/renderer.html: the shared renderer of text/html;profile=mcp-app
 * - MCP Tasks extension (io.modelcontextprotocol/tasks, 2026-07-28 dated-stable): kohaku_compose and the
 *   intent tools become task-capable for a request that opts in, but only when `AttachOptions.tasksEnabled`
 *   is also set (default false — see that option's doc comment for why: tasks/get is currently unreachable
 *   over the wire on the installed SDK).
 */
export function attachKohakuToMcpServer(server: McpServer, deps: McpHostDeps, options: AttachOptions): void {
  const prefix = options.toolPrefix ?? "kohaku";
  const fallbackPrincipal = deps.principal ?? ANONYMOUS;

  // Resolves the principal for one tool call — see McpHostDeps.resolvePrincipal's doc comment for the full
  // fallback order and rationale. A throw from deps.resolvePrincipal is deliberately NOT caught here: it
  // propagates out of the `await ctx.principalOf(extra)` call inside each handler's safeTool body, so
  // safeTool's own try/catch turns it into a structured tool error (isError) and reports it to onError —
  // fail-closed, never silently downgraded to fallbackPrincipal or anonymous.
  const principalOf = async (extra: ServerContext): Promise<Principal> =>
    deps.resolvePrincipal != null ? await deps.resolvePrincipal(extra) : fallbackPrincipal;

  const getRendererHtml = async (): Promise<string> =>
    typeof options.rendererHtml === "function" ? options.rendererHtml() : options.rendererHtml;

  // Built once per attach call rather than per tool call: it holds no per-request state (see the ToolContext
  // doc comment in types.ts), so there is nothing to gain from rebuilding it on every compose. tasks is the
  // one exception that DOES hold state (the in-memory task store), but it too is scoped to this attach call
  // (one store per McpServer instance) rather than per tool call — see tasks.ts's createTaskStore doc comment.
  // principalOf, unlike the old attach-time `principal` field it replaces, is resolved per tool call (see
  // McpHostDeps.resolvePrincipal's doc comment) — each handler calls it once, inside its own safeTool body,
  // and builds a ToolCallContext (via forCall) to carry the resolved value through the compose pipeline.
  const ctx: ToolContext = {
    server,
    deps,
    options,
    prefix,
    principalOf,
    getRendererHtml,
    fixationHost: fixationHost(deps),
    allowedActions: hostCore.createAllowedActions(deps.domain),
    tasks: createTaskStore(),
  };
  taskStoresByServer.set(server, ctx.tasks);

  // Registration order matters: it is observable via tools/list, so it must not be reordered.
  registerRendererResource(ctx);
  registerComposeTool(ctx);
  registerRenderSnapshotTool(ctx);
  registerIntentTools(ctx);
  registerResolveBindingTool(ctx);
  registerEventTool(ctx);
  registerActionTool(ctx);
  // tasks/get and tasks/cancel are not tools (no tools/list visibility), so their registration is not subject
  // to the ordering constraint above. Gated behind AttachOptions.tasksEnabled (default off) — see its doc
  // comment and registerTaskMethods' doc comment for why: while tasks/get is unreachable on the installed
  // SDK, declaring the extension / registering these methods at all would be pure surface area with no
  // corresponding capability, so leave the server silent about the extension entirely by default.
  if (options.tasksEnabled === true) registerTaskMethods(ctx);
}

/**
 * Registers this profile's two Task-extension methods (see tasks.ts's module doc for why kohaku defines its
 * own types rather than the SDK's deprecated 2025-11-25 `tasks/*` vocabulary). `tasks/update` is deliberately
 * NOT implemented: it exists for a server that reaches `status: "input_required"` to collect mid-flight
 * input, and kohaku's compose takes none (an Intent's params are supplied up front; there is no server-side
 * "waiting on the client for more input" state anywhere in the composition pipeline) — so that half of the
 * extension has nothing to hook onto and is omitted rather than stubbed.
 *
 * Uses the SDK's documented consumer-owned extension seam: `Server.setRequestHandler(method, {params,
 * result?}, handler)` (the 3-arg form; verified against the installed `@modelcontextprotocol/server` 2.0.0
 * `.d.mts` — `tasks/get`/`tasks/cancel` are excluded from the typed 2-arg `RequestMethod` surface precisely
 * because they collide with the deprecated vocabulary's own method names, forcing this form). Declares the
 * extension in `ServerCapabilities.extensions` via `registerCapabilities` (mergeable post-construction,
 * unlike `ServerOptions.cacheHints` which is constructor-only — see cache-hints.ts's doc comment for that
 * asymmetry — so this package CAN self-wire the capability declaration, no caller-side change needed).
 *
 * *** KNOWN LIMITATION (verified empirically, not a kohaku bug — see docs/design.md §11's "MCP Tasks
 * extension" section for the full writeup, and test/tasks.test.ts's "known SDK limitation" describe block
 * for the reproduction/tripwire) ***: with the installed
 * `@modelcontextprotocol/server` 2.0.0, these two handlers are registered correctly but are NEVER DISPATCHED
 * TO on a 2026-07-28-negotiated connection. The SDK's inbound-request routing rejects any method name that
 * (a) is recognized somewhere across its own frozen per-era wire tables — `tasks/get`/`tasks/cancel` ARE
 * recognized, as the deprecated 2025-11-25 vocabulary's own method names — but (b) is not in the *negotiated*
 * era's own table (the 2026-07-28 core codec has no core `tasks/*` methods; this extension isn't core spec).
 * That check runs before handler lookup, so it answers -32601 Method not found unconditionally, regardless of
 * registration, declared capabilities/extensions, or which registration form is used. A genuinely novel
 * method name (no collision) dispatches fine through the identical seam — this is specifically a name
 * collision with the SDK's own reserved (if inert) legacy vocabulary. Kept registered anyway: the code is
 * spec-correct and forward-compatible with a future SDK release that either drops the reservation or ships
 * an official Tasks runtime — re-verify this limitation when upgrading @modelcontextprotocol/server.
 */
function registerTaskMethods(ctx: ToolContext): void {
  const protocol = ctx.server.server;
  protocol.registerCapabilities({ extensions: { [TASKS_EXTENSION_ID]: {} } });
  const taskIdParams = z.object({ taskId: z.string() });
  protocol.setRequestHandler("tasks/get", { params: taskIdParams }, async ({ taskId }) => {
    const task = ctx.tasks.get(taskId);
    if (task == null)
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown or expired taskId: ${taskId}`);
    // No `result` schema is supplied above (RequestHandlerSchemas.result is optional and, per its own doc,
    // unvalidated at runtime either way), so the inferred return type falls back to the SDK's generic Result
    // shape (a string index signature). DetailedTask's discriminated union deliberately has no such index
    // signature (it is meant to be narrowed on `status`), so this is a plain type-level cast, not a runtime one.
    return task as unknown as Record<string, unknown>;
  });
  protocol.setRequestHandler("tasks/cancel", { params: taskIdParams }, async ({ taskId }) => {
    const verdict = ctx.tasks.requestCancel(taskId);
    if (!verdict.ok)
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown or expired taskId: ${taskId}`);
    return {};
  });
}

/**
 * Per-deps keyed mutex for the MCP profile's fixation self-heal serialization (symmetric with host-rest's
 * fixationMutexByDeps in keyed-mutex.ts). The MCP profile never resolves a tenant, so unlike the REST lock
 * (keyed by `(tenant, intentHash)`) this one is keyed by `intentHash` alone.
 */
const fixationMutexByDeps = new WeakMap<McpHostDeps, hostCore.KeyedMutex>();

/**
 * Side channel from an `McpServer` instance to the in-memory `TaskStore` `attachKohakuToMcpServer` built for
 * it, read by `__getTaskStoreForTest` below. Exists because `tasks/get`/`tasks/cancel` are currently
 * unreachable over the wire on this SDK version (see `registerTaskMethods`'s doc comment) — without it,
 * nothing outside this module could exercise `requestCancel`'s propagation into a running compose's
 * `AbortController` at all, since `ToolContext` and `startComposeTask` are both module-private.
 */
const taskStoresByServer = new WeakMap<McpServer, TaskStore>();

/**
 * Test-only escape hatch (not part of the public `index.ts` surface, same style as
 * `__setPreresolveTimeoutMsForTest`): returns the `TaskStore` `attachKohakuToMcpServer` built for `server`,
 * so a test can call `requestCancel` directly on the exact same store `tasks/get`/`tasks/cancel` would
 * consult if they were reachable — see `registerTaskMethods`'s doc comment for why they currently are not.
 */
export function __getTaskStoreForTest(server: McpServer): TaskStore | undefined {
  return taskStoresByServer.get(server);
}

/**
 * Adapts McpHostDeps into the FixationDeliveryHost surface host-core's fixation helpers consume. The MCP
 * profile still never resolves a tenant (self-healing calls always carry `tenant: undefined`), but `serialize`
 * is wired to host-core's shared keyed mutex (keyed by `intentHash` alone) so a self-heal get→put racing
 * with this same process's own fixate/unfixate no longer interleaves (the same hardening host-rest already
 * had via `withFixationLock`, narrowed to what the MCP profile can key on).
 */
function fixationHost(deps: McpHostDeps): hostCore.FixationDeliveryHost {
  return {
    lookup: deps.fixationLookup,
    admit: deps.fixationAdmit,
    fixations: deps.fixations,
    serialize: (scope, fn) => {
      let mutex = fixationMutexByDeps.get(deps);
      if (mutex == null) {
        mutex = hostCore.createKeyedMutex();
        fixationMutexByDeps.set(deps, mutex);
      }
      return mutex(scope.intentHash, fn);
    },
    onSelfHealError: (endpoint, error) => {
      void reportMcpError(deps, endpoint, error);
    },
  };
}

/**
 * Normalizes the tool input into a CanonicalIntent (host-core's resolveIntent, shared with the REST profile's
 * /events GUI-delta site — skipped for the "canonical" ComposeSource kind, whose Intent is already finalized;
 * see ComposeSource's doc comment), then delegates the fixation shortcut / normal-compose sequence to
 * host-core's composeWithFixation (also shared with the REST profile). One session per tool call: the
 * caller-provided locale rides SessionContext.locale so NL normalization, the fixation gate, and the compose
 * policy (ComposeContext.policyFor) all see it. The MCP profile has a single ComposeContext (deps.compose), so
 * it is passed as both the materialize and (by omission, defaulting to materialize) the normal-compose context.
 *
 * `abort`, when passed, propagates into composeWithFixation's normal-compose fallback (the fixation shortcut
 * itself never calls the LLM, so it has nothing to cancel) — see composeAndAudit's doc comment for why tool
 * handlers thread the SDK's `extra.mcpReq.signal` through here.
 *
 * `requestId`, when passed (the SDK's `extra.mcpReq.id`, the JSON-RPC id of the tool call), is forwarded to
 * composeWithFixation as the correlation id — see composeAndAudit's doc comment.
 *
 * `traceContext` (from `_meta.traceparent`, see traceContextOf), when passed, is forwarded to
 * composeWithFixation the same way, additively (ComposeOptions.traceContext).
 */
async function composeForTool(
  ctx: ToolCallContext,
  input: ComposeSource,
  callCtx?: ComposeCallContext,
): Promise<ComposeResult> {
  // Attach ctx.principal (this call's already-resolved principal — see McpHostDeps.resolvePrincipal's doc
  // comment), symmetric with registerEventTool's mcpSession(locale, call.principal) call — without it,
  // SemanticPort.normalize / policyFor / the fixation lookup would see an anonymous session on the compose
  // path only, diverging from the kohaku_event path for the same resolved principal.
  const session = mcpSession(callCtx?.locale, ctx.principal);
  const intent =
    input.kind === "canonical"
      ? input.intent
      : (await hostCore.resolveIntent(ctx.deps.compose.semantic, input, session)).intent;
  return hostCore.composeWithFixation(
    intent,
    session,
    { materialize: ctx.deps.compose, ...(callCtx?.abort != null ? { abort: callCtx.abort } : {}) },
    ctx.fixationHost,
    callCtx?.requestId,
    callCtx?.traceContext,
  );
}

/**
 * Observability of failure paths. Silent if onError is unwired. A throw from the hook is swallowed
 * (observation only), via host-core's notifyHook (the shared swallow-on-throw building block, also consumed
 * by the REST profile's reportHostError). Same shape as the REST surface's reportHostError, but the MCP
 * surface has no error envelope, so there is no requestId.
 */
async function reportMcpError(deps: McpHostDeps, endpoint: string, error: unknown): Promise<void> {
  await hostCore.notifyHook(deps.onError, { endpoint, error });
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
    // MCP 2026-07-28 (SEP-2322) requires every result to carry `resultType`. An error is still a
    // *complete* result (as opposed to an MRTR `"input_required"` interim result, which this profile
    // never produces) — see safeTool's doc comment.
    resultType: "complete" as const,
  };
}

/**
 * The client-safe message for a thrown `authz.verify` (an infrastructure failure, e.g. a revocation-store
 * outage -- see `AuthzPort.verify`'s doc comment in spec-core's `ports.ts`). Symmetric with the REST
 * surface's binding routes, which use the same fixed text for the same failure.
 */
const CAPABILITY_VERIFICATION_UNAVAILABLE_MESSAGE = "capability verification unavailable";

/**
 * Calls `authz.verify`, converting a thrown error (fail-closed, per `AuthzPort.verify`'s doc comment: verify
 * throws only on infrastructure failure) into a structured tool error with a fixed, client-safe message,
 * rather than letting it fall through to `safeTool`'s generic internal-error fallback (which would still be
 * fail-closed, but with a less specific message) or propagate as an unhandled rejection. The original error
 * still reaches the observability hook via reportMcpError.
 */
async function verifyCapability(
  deps: McpHostDeps,
  endpoint: string,
  capability: string,
  req: VerifyRequest,
): Promise<VerifyResult | ReturnType<typeof toolError>> {
  try {
    return await deps.authz.verify(capability, req);
  } catch (e) {
    await reportMcpError(deps, endpoint, e);
    return toolError(CAPABILITY_VERIFICATION_UNAVAILABLE_MESSAGE);
  }
}

/**
 * The client-visible message for an untyped tool failure (an exception safeTool catches that no explicit
 * `toolError(...)` call inside the tool body already produced). Same rule as the REST surface's
 * COMPOSE_FAILED_MESSAGE (host-core's isTypedHostError): an arbitrary exception (a downstream library
 * failure, an unexpected bug) may carry internals unsafe to echo back; a typed host error
 * (SpecError/ComposeError/QueryRefError) still passes its own message through. The original error still
 * reaches the observability hook (onError) via reportMcpError.
 */
const TOOL_INTERNAL_ERROR_MESSAGE = "internal error; see the observability hook (onError) for details";

/**
 * Converts a tool handler's failure into a structured tool error (isError) rather than an MCP RPC-level exception.
 * Symmetric with how the REST side turns parseQueryRef etc. into a 400 via try/catch, this lets normalization,
 * reference-resolution, and composition failures be returned as tool results (the success-case return value is unchanged).
 *
 * Also the single point where MCP 2026-07-28's required `resultType` field (SEP-2322) is stamped onto every tool
 * result this profile returns (both the success path here and toolError's error path): every handler in this
 * file routes its return value through safeTool, so this one wrapper covers `${prefix}_compose` /
 * `_render_snapshot` / the intent tools / `_resolve_binding` / `_event` / `_action` uniformly. This profile never
 * produces an MRTR `"input_required"` interim result, but it now produces one OTHER non-`"complete"` value:
 * `"task"` (the MCP Tasks extension's `CreateTaskResult`, see `startComposeTask`) — `fn()` already stamps that
 * itself (`createTaskResult`), so this only fills in `"complete"` when the handler's own return value carries
 * no `resultType` at all, rather than unconditionally overwriting it (mirroring how the SDK's own 2026-era
 * encode seam "neither strips nor overrides the handler's own resultType" — see decision #38 in docs/design.md
 * §13). An SDK v1 client ignores the unknown field (the SDK's CallToolResult zod schema is passthrough), so
 * this is purely additive either way.
 */
async function safeTool<T extends object>(
  deps: McpHostDeps,
  endpoint: string,
  fn: () => Promise<T>,
): Promise<(T & { resultType: "complete" | "task" }) | ReturnType<typeof toolError>> {
  try {
    const result = await fn();
    const resultType = (result as { resultType?: unknown }).resultType;
    return { ...result, resultType: resultType === "task" ? "task" : "complete" };
  } catch (e) {
    // Symmetric with the REST surface (reportHostError before the COMPOSE_FAILED response), report the failure to the
    // observation hook before converting it to a tool error, rather than leaving the failure rate inferable only via the
    // isError response to the model.
    await reportMcpError(deps, endpoint, e);
    const clientMessage = hostCore.clientMessageFor(e, TOOL_INTERNAL_ERROR_MESSAGE);
    return toolError(clientMessage);
  }
}
