import type { ComposeContext, ComposePolicy } from "@kohaku-ui/composer";
import { createJudge, type SchemaExtractor } from "@kohaku-ui/evals/judge";
import {
  createDailyTokenLedger,
  createMemoryRateLimitStore,
  createPolicyRuntime,
  formatErrorChain,
  type PolicyRuntime,
} from "@kohaku-ui/host-core";
import { createKohakuRoutes, errorBody } from "@kohaku-ui/host-rest";
import { createFixations, createLineage, type Fixations, type Lineage } from "@kohaku-ui/lineage";
import type { LlmPort } from "@kohaku-ui/llm";
import { coreCatalog, type ResolvedCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type {
  ApprovalPort,
  AuthzPort,
  DomainPort,
  KohakuPolicyFile,
  Principal,
  StoragePort,
} from "@kohaku-ui/spec-core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createComposeContext, sharedComposePolicy } from "./app/compose-context.js";

// Re-exported for consumers outside the REST host (sample-mcp's fixation language gate, and app.ts below).
export { admitFixationForLocale, languageOf, type OutputLang } from "./app/compose-context.js";

import { createHostDeps } from "./app/host-deps.js";
import { createPromotionPipeline, PROMOTION_MIN_USES } from "./app/promotions.js";
import { createHeaderIdentity, type RequestIdentity } from "./app/request-identity.js";
import { salesContribution } from "./catalog/contribution.js";
import { createSalesDomainPort } from "./domain/port.js";
import type { SalesRepo } from "./domain/repo.js";
import { createSalesIntentCatalog, type IntentCatalog } from "./intents/catalog.js";
import { type PromotedEntry, promotedComponent } from "./intents/promoted.js";
import { PromotedRegistry } from "./intents/promoted-registry.js";
import { createSemanticPort } from "./ports/semantic-port.js";

/**
 * Request body size cap for /api/kohaku/* (ops; product responsibility — see the bodyLimit wiring below).
 * 1 MiB comfortably covers a real /compose or /events payload (an NL question or an Intent + params) with
 * headroom; larger requests are almost certainly abuse or a client bug and are rejected before JSON parsing.
 */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/**
 * Nomination threshold for fixation candidates (an L1 view must have been rendered this many times before it
 * is offered for L0 fixation). Exported so GET /analytics/summary's `promotionPolicy` (bundled below) is the
 * single source sample-web's i18n copy (ui.ts's `admin.fixations.candidatesEmpty`) reads the number from,
 * instead of duplicating it as a string literal.
 */
export const FIXATION_MIN_USES = 3;

/** 413 response for a request body over MAX_REQUEST_BODY_BYTES, in the same error-envelope shape as host-rest's own errors. */
function bodyTooLargeResponse(c: Context): Response {
  return c.json(errorBody("BAD_REQUEST", "request body too large"), 413);
}

/**
 * The environment-neutral core of AppDeps: this file (`app-core.ts`) has no Node-only static import, and is
 * the `./browser` export's entry point (see `browser.ts`). `repo` is therefore mandatory here, unlike the
 * Node-facing `AppDeps` re-exported from `app.ts` (the package's `"."` export) — that file's own `AppDeps`
 * makes `repo` optional and defaults it by reading the real demo seed from disk (`domain/seed-fs.ts`), which
 * only its own thin wrapper around `createApp` (below) is allowed to import.
 */
export interface AppDeps {
  llm: LlmPort;
  storage: StoragePort;
  authz: AuthzPort;
  repo: SalesRepo;
  /**
   * Optional LLM auto-extraction of the promotion schema (advisory prefill for the approval form). Unset =
   * candidates carry no suggestion (the pre-existing behaviour) — every FakeLlm-scripted e2e test relies on
   * this default so its scripted response order is unaffected by an extraction call it did not script.
   * index.ts is the only caller that wires a real one (createSchemaExtractor), at the process entry point.
   */
  schemaExtractor?: SchemaExtractor;
  /** Request → principal/tenant resolution. Default: the demo's x-kohaku-role / x-kohaku-tenant headers. */
  identity?: RequestIdentity;
  /**
   * Registers the demo-only `POST /api/kohaku/admin/bump-data-version` route (below the identity middleware +
   * governance RBAC, operation `admin.bumpDataVersion`). Cache-busting is free LLM-spend amplification for
   * anyone who can reach it, so under a real identity scheme (JWT) it defaults to **off** and must be opted
   * into explicitly. Default: `identity == null` (the header-based demo identity, where the legacy "anyone
   * behind the demo header can bump" behavior is preserved for local development).
   */
  demoAdminRoutes?: boolean;
  /**
   * Pre-delivery smoke validation of L2-generated HTML (`@kohaku-ui/sandbox/smoke`'s `createL2Smoke()`).
   * Unset (default) = no smoke validation. index.ts is the only caller that wires a real one, at the
   * process entry point — mirroring `schemaExtractor`'s convention. Optional (rather than defaulted here)
   * so this file never has to import `@kohaku-ui/sandbox/smoke` conditionally on the caller's environment:
   * a host with no jsdom/`node:vm` available (the static playground, U5) simply omits it, instead of paying
   * for createL2Smoke's own per-call fail-open dynamic import on every L2 compose.
   */
  l2Smoke?: ComposePolicy["l2Smoke"];
  /**
   * Clock override for the NL-normalization prompt's "current period" / "current quarter" derivation
   * (`ports/semantic-port.ts`'s `now`). Default: real time (`() => new Date()`, unchanged). A host that
   * replays fixtures keyed by exact prompt content (ReplayLlm, the static playground) must inject the same
   * fixed date used when the fixtures were recorded, or the derived prompt text — and therefore the fixture
   * key — drifts from what was recorded.
   */
  now?: () => Date;
  /**
   * Wraps the compose observer with `@kohaku-ui/otel`'s OTel observer when true (default false, unchanged
   * behavior). Previously this file read `process.env.KOHAKU_OTEL` directly; that decision now belongs to
   * whichever Node entry point has an env to read (index.ts) so this file never references `process` at all.
   */
  otel?: boolean;
  /**
   * Verbose error logging on the failure path: the compose observer's console output
   * (`app/compose-context.ts`) and host-rest's own `onError` hook (`app/host-deps.ts`) both print the full
   * cause chain (`@kohaku-ui/host-core`'s `formatErrorChain`) and the stack trace instead of a one-line
   * summary when this is true. Default false. A concurrent branch (T0-2) originally read
   * `process.env.KOHAKU_DEBUG` directly in both of those files; merged in as a plain parameter instead, for
   * the same reason `otel` is one — this file must stay env-neutral, and only index.ts has an env to read.
   */
  debug?: boolean;
  /**
   * Policy as Code (design.md #69/#70 — optional, off by default). When set, a `PolicyRuntime` is built
   * (host-core's `createPolicyRuntime`) and layered onto the compose policy (allowL2/budget/etc., per
   * tenant), the compose-family REST routes' rate limiter, and lineage's `policy.applied` audit event.
   * When unset, behavior is unchanged from before Policy as Code existed (no rate limiting, no per-tenant
   * allowL2/budget override, byte-identical compose policy/fingerprint for every existing test). Already
   * a plain, pre-parsed value (never a file path) — this file never reads `node:fs` either way; only a
   * Node-only caller (index.ts, via host-core's `./policy-node` subpath) is expected to load one from disk.
   */
  policyFile?: KohakuPolicyFile;
  /**
   * Verifies stateless approval tokens for "approve"-tier actions (design.md #62/#63; the demo's
   * DomainPort declares "publish" as tier "approve" — apps/sample-api/src/domain/port.ts). Unset by
   * default: an "approve"-tier action can then never be allowed (the gate returns denied), unchanged
   * from before governed actions existed. index.ts wires a real one (createHmacApprovalPort, reusing
   * the same KOHAKU_CAPABILITY_SECRET as the AuthzPort) for the running demo; tests wire their own.
   */
  approvals?: ApprovalPort;
}

export interface SampleApp {
  app: Hono;
  repo: SalesRepo;
  intentCatalog: IntentCatalog;
  composeCtx: ComposeContext;
  domain: DomainPort;
  /**
   * View Lineage (the record destination for promotion, fixation, and audit).
   * The REST side wires createViewRecorder(lineage) into host-rest to record on every compose, but the MCP side
   * (sample-mcp) builds the host through a different route, so this is exposed to share the same lineage and let
   * createViewRecorder rebuild the recorder.
   */
  lineage: Lineage;
  /**
   * The management surface of fixation. Exposed so the MCP side (sample-mcp) can fire the self-healing of
   * staleness detection (invalidate / refreshFingerprint) just like the REST side.
   */
  fixations: Fixations;
  /**
   * The Policy as Code runtime (design.md #69/#70), when `AppDeps.policyFile` was set. Exposed so a
   * caller (e.g. an admin console, or a test verifying "changing the policy changes the fingerprint") can
   * `reload()` it directly. `undefined` when `AppDeps.policyFile` was not set (backward compatible).
   */
  policyRuntime?: PolicyRuntime;
  /**
   * Flips the readiness flag GET /api/health reports (ops; graceful shutdown). index.ts calls this with
   * `true` on SIGINT/SIGTERM so a load balancer polling /api/health stops routing new traffic to this
   * instance while in-flight requests drain, ahead of the connection-close/drain-window sequence. Exposed
   * as a plain setter (rather than only reacting to real OS signals) so tests can exercise the 503 response
   * deterministically without sending a signal to the test process itself.
   */
  setShuttingDown(value: boolean): void;
}

/**
 * The heart of the sample API's wiring:
 * assembles the 4 Port implementations + core catalog (+) contributions (+) promotions (per-tenant, mutable) +
 * composer + host-rest + the promotion pipeline / fixation into a single Hono.
 *
 * Promotion (publish) is separated per tenant: tenant A's approval is reflected only in A's catalog / Intents,
 * and at compose time the catalog of session.tenant is resolved (the fingerprint changes, so caches separate naturally).
 * The promotion-state snapshot (promotions.json) is the sole state authority, and startup reconcile rebuilds
 * its projection (the registry's per-tenant catalogs) from the snapshot. Therefore createApp is async.
 */
export async function createApp(deps: AppDeps): Promise<SampleApp> {
  const repo = deps.repo;
  // Capture the core Intent names (INTENT_DEFS) as reserved words (used to reject name collisions of promoted Intents).
  const coreIntentNames = new Set(createSalesIntentCatalog().names());

  // --- Per-tenant mutable catalog: promotion (publish) adds components, and the fingerprint changes per tenant ---
  function buildCatalog(entries: PromotedEntry[]): ResolvedCatalog {
    return resolveCatalog(coreCatalog, salesContribution, {
      components: entries.map(promotedComponent),
    });
  }
  const registry = new PromotedRegistry(buildCatalog, coreIntentNames);

  const semantic = createSemanticPort({
    repo,
    // NL normalization / resolveQuery look up the tenant's Intent catalog (vocabulary separation of promoted Intents).
    catalogFor: (tenant) => registry.intentCatalogFor(tenant),
    llm: deps.llm,
    ...(deps.now != null ? { now: deps.now } : {}),
  });

  const domain = createSalesDomainPort(repo);

  // --- Lineage (built ahead of composeCtx: Policy as Code's audit event, below, needs it) ---------
  const lineage = createLineage({ storage: deps.storage });

  // --- Policy as Code (design.md #69/#70 — optional, off by default; see AppDeps.policyFile) ------
  // `shared` is built exactly once and passed to both createPolicyRuntime (as basePolicyFor, ignoring
  // its tenant argument — shared never varies by tenant; only the policy file introduces tenant variance)
  // and createComposeContext (as the base policyFor falls back to when policyRuntime is unset) — the
  // *same* object both times, so createPolicyRuntime's per-tenant memoization sees a stable base identity
  // (see PolicyRuntime.policyFor's doc comment) rather than a fresh l2Smoke/routeTier closure per call.
  const shared = sharedComposePolicy(deps.l2Smoke);
  const policyRuntime: PolicyRuntime | undefined =
    deps.policyFile != null
      ? await createPolicyRuntime({
          file: deps.policyFile,
          basePolicyFor: () => shared,
          ledger: createDailyTokenLedger(),
          rateLimitStore: createMemoryRateLimitStore(),
          // A RateLimitStore failure is fail-open (createRateLimiter already lets the request through);
          // this only makes that failure observable, reusing the same console-based, debug-aware
          // reporting style as host-deps.ts's onError / compose-context.ts's observer.onError.
          onRateLimitError: ({ error, tenant, principal, routeClass }) => {
            const label = `[policy] rate-limit store failed for tenant=${tenant ?? "-"} principal=${principal ?? "-"} routeClass=${routeClass} (failing open)`;
            console.error((deps.debug ?? false) ? `${label}: ${formatErrorChain(error)}` : label);
          },
          // Records policy.applied (lineage, task 9) on every effective change. actor is reload()'s own
          // free-string label (an operator id, "system", …); mapped onto lineage's typed Actor shape as a
          // "system" actor carrying that label as its id (a policy reload is an operational/config action,
          // never a "model"-kind actor, and this demo has no principal-typed caller for it). Tenant-neutral
          // (omitted): the event's own `tenants` field already carries the affected roster, and the change
          // itself is cross-tenant by nature (a whole file swap), not scoped to one tenant's own timeline.
          audit: (event, actor) =>
            lineage.policyApplied(event, actor != null ? { kind: "system", id: actor } : undefined),
        })
      : undefined;

  const composeCtx = createComposeContext({
    registry,
    semantic,
    storage: deps.storage,
    llm: deps.llm,
    shared,
    ...(policyRuntime != null ? { policyRuntime } : {}),
    otel: deps.otel ?? false,
    debug: deps.debug ?? false,
  });

  // --- Promotion / fixation --------------------------------------------------
  const judge = createJudge({ llm: deps.llm, passScore: 0.5 });

  const promotions = createPromotionPipeline({
    lineage,
    storage: deps.storage,
    registry,
    judge,
    ...(deps.schemaExtractor != null ? { schemaExtractor: deps.schemaExtractor } : {}),
  });

  // Snapshot authority -> projection startup reconciliation. Rebuilds the per-tenant catalogs from the published
  // snapshot. A projection left unapplied by a mid-publish failure also converges here via idempotent re-application of onPublish.
  await promotions.reconcile();

  const fixations = createFixations({
    lineage,
    storage: deps.storage,
    policy: { minUses: FIXATION_MIN_USES, minDistinctSessions: 1, structuralStability: 0.9 },
    // The source that stamps the catalog fingerprint of the given tenant at fixation time (because promotion is split per tenant).
    catalogFor: (tenant) => registry.componentCatalogFor(tenant),
    // Observability of a corrupted fixation record read back from storage (the demo is console-based, same
    // convention as promotions.ts's onError below). A validation failure here is already fail-open (the
    // record is treated as absent by the caller); this only surfaces that it happened.
    onError: ({ endpoint, intentHash, tenant }, error) => {
      console.error(
        `[fixations] failed to validate a persisted fixation record for ${endpoint} (intentHash=${intentHash}${tenant != null ? `, tenant=${tenant}` : ""}):`,
        error,
      );
    },
  });

  const identity = deps.identity ?? createHeaderIdentity();
  const hostDeps = createHostDeps({
    composeCtx,
    domain,
    authz: deps.authz,
    storage: deps.storage,
    lineage,
    promotions,
    fixations,
    identity,
    debug: deps.debug ?? false,
    ...(policyRuntime != null ? { rateLimiter: policyRuntime.rateLimiter } : {}),
    ...(deps.approvals != null ? { approvals: deps.approvals } : {}),
  });

  const app = new Hono();
  // Request body size cap (ops). host-rest is a library and deliberately imposes no size limit of its own
  // (that belongs to the deployment: a reverse proxy, or the product wiring this middleware) — the sample
  // wires a 1 MiB cap here so an oversized POST (e.g. to /compose) is rejected before JSON parsing rather than
  // consuming memory/CPU unbounded. Registered ahead of the route mount so it runs for every /api/kohaku/* request.
  app.use("/api/kohaku/*", bodyLimit({ maxSize: MAX_REQUEST_BODY_BYTES, onError: bodyTooLargeResponse }));
  // When identity requires JWT verification, authenticate the request before it reaches the routes (401
  // CAPABILITY_DENIED on a missing/invalid token — see createJwtRequestIdentity's doc comment). Absent for the
  // default header-based identity (behavior unchanged).
  if (identity.middleware != null) app.use("/api/kohaku/*", identity.middleware);
  // Bundle the nomination thresholds into GET /analytics/summary's response: sample-web's i18n copy
  // ("N or more times") reads the number from here instead of duplicating FIXATION_MIN_USES / PROMOTION_MIN_USES
  // as string literals. host-rest's route itself carries no notion of these product-specific policies, so this
  // is layered on as response-rewriting middleware ahead of the mount rather than a host-rest feature. Only
  // rewrites a successful (2xx) response; a 403/501/etc. passes through unchanged.
  app.use("/api/kohaku/analytics/summary", async (c, next) => {
    await next();
    if (c.res.ok) {
      const body = (await c.res.clone().json()) as Record<string, unknown>;
      c.res = c.json({
        ...body,
        promotionPolicy: { fixationMinUses: FIXATION_MIN_USES, promotionMinUses: PROMOTION_MIN_USES },
      });
    }
  });

  // Demo cache-busting (see AppDeps.demoAdminRoutes's doc comment for why this is opt-in under JWT). Registered
  // ahead of the host-rest mount but *after* the bodyLimit / identity.middleware `app.use("/api/kohaku/*", …)`
  // calls above, so this route sits behind both exactly like every host-rest route does. Authorization reuses
  // hostDeps.authorizeGovernance (the same GovernancePolicy instance host-rest's own routes check) under the
  // operation kind "admin.bumpDataVersion" — admin's "*" pattern allows it, reviewer/viewer are denied by
  // deny-by-default, and it fails closed (denied) if authorizeGovernance is somehow unwired, unlike host-rest's
  // own fail-open default: unlike the read/write routes host-rest already protects, this is a pure "spend the
  // product's LLM budget" lever, so treating "no policy wired" as "allowed" would be the wrong default here.
  if (deps.demoAdminRoutes ?? deps.identity == null) {
    app.post("/api/kohaku/admin/bump-data-version", async (c) => {
      const principal: Principal | null = await identity.auth(c);
      if (principal == null) {
        return c.json(errorBody("CAPABILITY_DENIED", "authentication required"), 401);
      }
      const tenant = await identity.tenant(c);
      const allowed =
        (await hostDeps.authorizeGovernance?.(principal, { kind: "admin.bumpDataVersion" }, tenant)) === true;
      if (!allowed) {
        return c.json(
          errorBody("CAPABILITY_DENIED", 'governance operation "admin.bumpDataVersion" was not authorized'),
          403,
        );
      }
      return c.json({ dataVersion: repo.bump() });
    });
  }

  app.route("/api/kohaku", createKohakuRoutes(hostDeps));

  // Readiness flag for graceful shutdown (ops): index.ts flips this via setShuttingDown(true) on SIGINT/SIGTERM,
  // ahead of closing the server, so a load balancer polling /api/health stops routing new traffic here while
  // in-flight requests still get to drain. Scoped per createApp instance (so tests get an isolated flag too).
  let shuttingDown = false;

  app.get("/api/health", (c) => {
    if (shuttingDown) {
      return c.json({ ok: false, reason: "shutting down" }, 503);
    }
    // health shows the tenant-neutral (base) catalog (if x-kohaku-tenant is present, it looks at that tenant).
    const tenant = c.req.header("x-kohaku-tenant") || undefined;
    return c.json({
      ok: true,
      llm: { provider: deps.llm.provider, model: deps.llm.modelId },
      seed: { records: repo.records.length, dataVersion: repo.dataVersion() },
      catalogVersion: registry.componentCatalogFor(tenant).fingerprint,
      intents: registry.intentCatalogFor(tenant).names(),
      // promoted is the promoted componentTypes across all tenants (deduplicated). See /catalog for the per-tenant breakdown.
      promoted: registry.allPromotedComponentTypes(),
    });
  });

  // The demo cache-bust route now lives at POST /api/kohaku/admin/bump-data-version (identity + governance
  // RBAC below), registered above ahead of the host-rest mount — see AppDeps.demoAdminRoutes.

  // Promotion approve/reject/withdraw have been elevated to first-class host-rest named routes
  // (POST /api/kohaku/promotions/:id/approve|reject|withdraw).
  // reviewer/actor are injected from the server-side principal (host-rest's getPrincipal).

  // intentCatalog exposes base (tenant-neutral + the default tenant's promotions) (used by sample-mcp at startup to
  // bulk-generate MCP tools via intentToolsFromCatalog(list()). For a single-tenant MCP, base is sufficient).
  return {
    app,
    repo,
    intentCatalog: registry.intentCatalogFor(undefined),
    composeCtx,
    domain,
    lineage,
    fixations,
    ...(policyRuntime != null ? { policyRuntime } : {}),
    setShuttingDown: (value) => {
      shuttingDown = value;
    },
  };
}
