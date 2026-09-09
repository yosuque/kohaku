import type { ComposeContext, ComposeTrace } from "@kohaku-ui/composer";
import type {
  ActionEffects,
  FixationDeliveryHost,
  FixationSelfHealApi,
  ViewRecorder,
} from "@kohaku-ui/host-core";
import type {
  AuthzPort,
  CanonicalIntent,
  DomainPort,
  FixationRecord,
  JsonObject,
  Principal,
  SessionContext,
  UISpec,
} from "@kohaku-ui/spec-core";
import type { CacheHint, McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { TaskStore } from "./tasks.js";

/**
 * The input accepted by the MCP compose surface: a natural-language question, a structured Intent (not yet
 * finalized/hashed), or an already-finalized CanonicalIntent. The "canonical" kind lets a caller that has
 * already gone through host-core's resolveIntent (e.g. registerEventTool's GUI-delta path) hand the resolved
 * CanonicalIntent straight to composeForTool without a second normalize+finalize pass — finalizeIntent is a
 * pure hash computation, but calling it twice for the same Intent computed the hash twice on the "gui" event
 * path (finalizeIntent's own hasHash short-circuit only helps when the caller passes the CanonicalIntent
 * through as-is, not when it is re-destructured into a plain `{canonical, params}` literal, which is what the
 * "intent" kind's shape requires).
 * A narrower set than the composer's ComposeInput (the GUI kind enters via `${prefix}_event` payloads instead).
 * Mirrors the Python port's _ComposeSource.
 */
export type ComposeSource =
  | { kind: "nl"; text: string }
  | { kind: "intent"; intent: { canonical: string; params: JsonObject } }
  | { kind: "canonical"; intent: CanonicalIntent };

export interface McpHostDeps {
  compose: ComposeContext;
  domain: DomainPort;
  authz: AuthzPort;
  querySource: string;
  principal?: Principal;
  /**
   * The L1→L0 fixation short-circuit. The session (surface "mcp-app" + the caller-provided locale)
   * is passed so products can gate delivery — e.g. serve pinned Specs to EN sessions only, mirroring
   * the REST surface's language gate (FixationRecord carries no language). Implementations that
   * ignore the 2nd argument keep the legacy behavior.
   *
   * Prefer keeping this a plain read and expressing any delivery gate via `fixationAdmit` instead — the
   * same gate function can then be shared verbatim with the REST profile's `KohakuHostDeps.fixationAdmit`
   * rather than being duplicated in both hosts' `fixationLookup` implementations.
   */
  fixationLookup?: (intentHash: string, session: SessionContext) => Promise<FixationRecord | null>;
  /**
   * Delivery-admission gate consulted, when set, after a fixation is found via `fixationLookup` and before
   * it is checked for staleness (host-core's `FixationDeliveryHost.admit`). See `fixationLookup`'s doc — the
   * same function can be shared with the REST profile's `KohakuHostDeps.fixationAdmit`.
   */
  fixationAdmit?: (fixation: FixationRecord, session: SessionContext) => boolean | Promise<boolean>;
  /**
   * View Lineage recording, symmetric with the REST profile's KohakuHostDeps.recorder: `composed` /
   * `fallback` are recorded around every compose-family tool call (kohaku_compose / kohaku_render_snapshot /
   * intent tools / kohaku_event), and `interacted` is recorded by registerEventTool before recomposing —
   * matching the REST surface's /events, which records `interacted` before `composed`/`fallback`. When both
   * `recorder` and the legacy `onComposed` are wired, `recorder` takes priority (onComposed is not also
   * called) so a product migrating from one to the other does not double-record.
   */
  recorder?: ViewRecorder;
  /**
   * @deprecated Superseded by `recorder` (ViewRecorder), which additionally records `interacted` and
   * `fallback` (symmetric with the REST profile). Kept for backward compatibility: still called when
   * `recorder` is unwired. When both are wired, `recorder` takes priority and this is not called.
   */
  onComposed?: (spec: UISpec, trace: ComposeTrace) => Promise<void>;
  /**
   * Self-healing hook for fixation staleness detection (optional). Follows the same style as the
   * REST-surface FixationsApi: if materialize returns stale, invalidate; if revalidated, fire
   * refreshFingerprint outside the delivery path. Structurally the same shape as host-core's
   * FixationSelfHealApi (also shared by the REST profile's FixationsApi), which @kohaku-ui/lineage's
   * Fixations satisfies as-is. The MCP surface performs no tenant resolution, so options.tenant / scope.tenant
   * are never passed (it is not made perfectly symmetric with the REST surface) — but calls are still
   * serialized per `intentHash` within this process (see `ToolContext.fixationHost`'s `serialize`), guarding
   * against the same self-heal/fixate/unfixate interleaving the REST profile's fixation lock guards against.
   * When unwired, degrades to "stale → fall back to normal compose only (no self-healing record)".
   */
  fixations?: FixationSelfHealApi;
  /**
   * Observability hook for failure paths (product responsibility). Reports the fail-open of the audit
   * record (onComposed) and failures of fixation self-healing (invalidate/refreshFingerprint) here. Same
   * shape as REST's KohakuHostDeps.onError (the MCP surface has no error envelope, so no requestId is carried).
   * When unwired, silent (legacy behavior). A throw from the hook is swallowed (observation only).
   */
  onError?: (info: { endpoint: string; error: unknown }) => void | Promise<void>;
  /**
   * Side-effect declaration for writes (`${prefix}_action`) (optional). Same signature shape as the
   * REST-surface KohakuHostDeps.actionEffects. Called after domain.invoke; returns the `query://` URIs that
   * this write invalidates (invalidates) and the new per-reference versions (refVersions).
   * When unspecified, the response is `{ result }` only = backward-compatible (data-binding's parseActionResult
   * also parses the `{ result }` shape for backward compatibility). DomainPort is unchanged (the write itself is
   * domain.invoke; the side-effect "declaration" is separated out here).
   */
  actionEffects?: ActionEffects;
}

export interface IntentToolDef {
  name: string;
  description: string;
  /** zod raw shape (the MCP tool's inputSchema) */
  paramsShape: z.ZodRawShape;
  toIntent(args: JsonObject): { canonical: string; params: JsonObject };
}

export interface AttachOptions {
  /** Shared renderer bundle (same rendering code as the Web = pixel parity of Strategy A) */
  rendererHtml: string | (() => Promise<string>);
  intentTools?: IntentToolDef[];
  toolPrefix?: string;
  /**
   * Save hook for self-contained snapshot HTML (for UI-incapable hosts).
   * Registers the `${prefix}_render_snapshot` (model-visible) tool only when wired.
   * Receives a fileName (a name that does not collide on the caller side) and the HTML body, and returns a
   * locator string.
   * **The return value is a locator = local path or public URL. Delivery, saving, and URL-ization are the host
   * implementation's responsibility** (e.g., remote MCP over Streamable HTTP returns a URL and serves it statically,
   * while stdio returns a local path).
   * The library's responsibility ends at "generating the snapshot"; the returned string is placed verbatim into the
   * guidance text to the model.
   * When unwired, this tool is not registered (the HTML body is about 1MB, and exposing it without a write hook is pointless).
   */
  snapshotWriter?: (fileName: string, html: string) => Promise<string>;
  /**
   * mcp-ui legacy-host-compatible UIResource co-emission (default false = fully backward-compatible).
   * When enabled, appends the self-contained snapshot HTML to the `content[]` of compose-family tool results as
   * `{type:"resource", resource:{uri:"ui://kohaku/view/<intentHash>", mimeType:"text/html", text}}`.
   * A static-display path for legacy hosts that do not support SEP-1865 and render only mcp-ui's UIResource
   * (detected by the `ui://` prefix) (LibreChat / Smithery / Nanobot, etc.) — the static-display design, where
   * interaction and recomposition are not possible. **The HTML bundles the shared renderer at about 1MB/result**,
   * so do not enable it for modern hosts (Claude / ChatGPT) (the Claude family has a known issue where the widget
   * does not hydrate once a tool result exceeds about 150,000 characters — the same rationale as INITIAL_DATA_BUDGET_CHARS).
   * A failure to assemble the snapshot is swallowed, reported to the observation hook, and answered normally without the
   * co-emission (fail-open).
   */
  legacyUiResource?: boolean;
  /**
   * Overrides the `resources/read` cache hint (MCP 2026-07-28 / SEP-2549) attached to the shared
   * renderer resource (`ui://kohaku/renderer.html`). Defaults to `RENDERER_RESOURCE_CACHE_HINT`
   * (`cache-hints.ts`) when this option is entirely unset — see that constant's doc comment for the
   * reasoning. When set (even partially), it replaces that default outright as the per-resource hint
   * passed to `registerResource`; a field left unset *within* it then falls back per the SDK's own
   * resolution order to `ServerOptions.cacheHints["resources/read"]` (this package never configures
   * that), and finally to the conservative `{ ttlMs: 0, cacheScope: 'private' }`.
   */
  rendererResourceCacheHint?: CacheHint;
  /**
   * Enables the MCP Tasks extension (`io.modelcontextprotocol/tasks`, 2026-07-28 dated-stable) for the
   * compose-family tools (`${prefix}_compose` and `intentTools`) and this profile's `tasks/get`/
   * `tasks/cancel` methods. **Default `false` (unset).**
   *
   * MUST NOT be enabled until `tasks/get` is actually dispatchable on the installed
   * `@modelcontextprotocol/server` version — see docs/design.md §11's "MCP Tasks extension" subsection for
   * why it currently is NOT: a verified, reproducible SDK-version limitation where `tasks/get`/
   * `tasks/cancel` collide with the deprecated 2025-11-25 vocabulary's own reserved method names and are
   * rejected by the SDK's own inbound routing with `-32601` before ever reaching kohaku's handler,
   * regardless of registration, declared capabilities, or which registration form is used.
   *
   * **Left at its default (`false`/unset)**:
   *  - the server does not declare the extension in `ServerCapabilities.extensions` (`server/discover`
   *    does not claim support it could not fulfil),
   *  - `tasks/get` / `tasks/cancel` are not registered at all,
   *  - `${prefix}_compose` / the intent tools execute synchronously exactly as they did before this
   *    extension existed — byte-identical, even for a request that declares the extension capability on
   *    itself. A client that declared it gets exactly what a client that did not declared it gets.
   *
   * This is deliberate, not a conservative-default nicety: while `tasks/get` is unreachable, a
   * `CreateTaskResult` handed to a client is a task handle it can never poll — worse than no task handle
   * at all, and it would take away a working synchronous call from exactly the clients sophisticated
   * enough to have declared the extension in the first place.
   *
   * **How to check whether it is now safe to enable**: re-run the reproduction documented in
   * docs/design.md §11 against the installed SDK version (send a raw `tasks/get` request over a
   * negotiated 2026-07-28 connection and see whether it still answers `-32601`).
   * `packages/host-mcp-apps/test/tasks.test.ts`'s "known SDK limitation" describe block is the same check,
   * wired as an automatic tripwire — if it starts failing (the `-32601` assertion no longer holds),
   * `tasks/get` has become reachable and this option is safe to flip on.
   */
  tasksEnabled?: boolean;
}

/**
 * Shared context threaded through the per-tool registration functions (extracted from
 * attachKohakuToMcpServer so each `server.registerTool` / `registerResource` call lives in its own
 * function). Carries exactly what the registration functions and the compose-pipeline helpers need;
 * `server`/`deps`/`options` are kept whole rather than pre-destructured since several registration
 * functions read multiple fields off each.
 *
 * `fixationHost` is built once (per attachKohakuToMcpServer call) rather than per tool call: its `serialize`
 * closure holds a per-deps mutex (keyed by `intentHash` alone — unlike the REST profile, the MCP profile
 * never resolves a tenant), not per-request state, so there is nothing to gain from rebuilding it on every
 * compose.
 *
 * `allowedActions` is likewise built once (memoizing `deps.domain.listOperations()`, which is async and must
 * not be re-awaited on every compose) and used to restrict issued write scopes to actions the DomainPort
 * actually exposes (hardening against a hallucinated/injected action.invoke action name). Returns the current
 * allowed set on each call — retries against the DomainPort after a prior rejection.
 *
 * `tasks` is the one field here that DOES hold state (an in-memory task store — see tasks.ts's
 * `createTaskStore` doc comment for its lifetime/expiry design), still built once per `attachKohakuToMcpServer`
 * call (one store per `McpServer` instance, not per tool call).
 */
export interface ToolContext {
  server: McpServer;
  deps: McpHostDeps;
  options: AttachOptions;
  prefix: string;
  principal: Principal;
  getRendererHtml: () => Promise<string>;
  fixationHost: FixationDeliveryHost;
  allowedActions: () => Promise<ReadonlySet<string>>;
  tasks: TaskStore;
}
