import { withTenantCatalog } from "@kohaku-ui/composer";
import { cachedPropsJsonSchema } from "@kohaku-ui/registry";
import type { Principal } from "@kohaku-ui/spec-core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { errorBody } from "./errors.js";
import type { GovernanceOperation } from "./governance-policy.js";
import { createKeyedMutex } from "./keyed-mutex.js";
import { registerBindingRoutes } from "./routes/binding.js";
import { registerComposeRoutes } from "./routes/compose.js";
import { registerFixationRoutes } from "./routes/fixations.js";
import { registerGovernanceRoutes } from "./routes/governance.js";
import { registerPromotionRoutes } from "./routes/promotions.js";
import { ANONYMOUS, type RouteContext, requestIdOf, resolveTenant } from "./routes/shared.js";
import type { KohakuHostDeps } from "./types.js";

// The public types are defined in types.ts (relocated along with the route-group split). Re-export them from this module.
export type {
  ComponentDraftInput,
  FixationsApi,
  KohakuHostDeps,
  LineageSummarizer,
  PromotionsApi,
  ViewRecorder,
} from "./types.js";

/**
 * Default request-body size cap (bytes) applied by createKohakuRoutes when a host does not override
 * deps.maxBodyBytes. 1 MiB comfortably covers a real /compose or /events payload (an NL question or an
 * Intent + params) with headroom; larger requests are almost certainly abuse or a client bug. Mirrors the
 * sample host's own product-side bodyLimit (apps/sample-api/src/app.ts) so a host that mounts
 * createKohakuRoutes without pairing it with its own bodyLimit still gets a bound out of the box.
 */
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/**
 * The REST profile of the Kohaku Protocol (a group of Hono routes).
 * Usage: app.route("/api/kohaku", createKohakuRoutes(deps))
 *
 * Routes are split by group (under routes/: compose composition system / binding reference and write-through path /
 * governance audit-observability plane / promotions promotion management plane / fixations fixation management
 * plane), and the shared items scoped to the app instance (principal extraction, governance authorization,
 * promotion lock) are passed via RouteContext.
 */
export function createKohakuRoutes(deps: KohakuHostDeps): Hono {
  const app = new Hono();

  // Per-request correlation id (ops): resolve it once per request (requestIdOf memoizes on the raw Request)
  // and stamp it on every response of the mounted sub-app, success or failure, so a client/reverse-proxy/log
  // aggregator can correlate this request across the response header, the error envelope's `error.requestId`
  // (see routes/shared.ts's reportHostError), and the onError observability hook. Registered first so it runs
  // around every route below, including error responses returned by them.
  app.use("*", async (c, next) => {
    const requestId = requestIdOf(c, deps);
    await next();
    c.res.headers.set("X-Request-Id", requestId);
  });

  // Standard request-body size cap (a product may still layer its own bodyLimit in front of the mount point;
  // this is a bundled floor so a host that forgets to is not left fully unbounded). Rejects before the body
  // is buffered/JSON-parsed, ahead of routes/schemas.ts's structural validation (the depth cap on
  // JsonObjectSchema guards against a small-but-deeply-nested payload this size cap alone would not catch).
  app.use(
    "*",
    bodyLimit({
      maxSize: deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      onError: (c) => c.json(errorBody("BAD_REQUEST", "request body too large"), 413),
    }),
  );

  // Startup warning for the fail-open default of the governance/audit plane (allowed without authorization when not wired).
  // The fail-open default itself is intentional (backward compatible; governance authorization is a
  // product responsibility), but since it is dangerous to silently miss an unprotected public exposure, warn exactly
  // once. If already protected by external middleware (a reverse proxy, etc.), this is expected.
  if (deps.authorizeGovernance == null) {
    console.warn(
      "[kohaku] Governance/audit routes (/lineage, /telemetry, /promotions*, /fixations*) are exposed without authorization. " +
        "In production, wiring deps.authorizeGovernance or protecting them with external middleware is mandatory.",
    );
  }
  // Symmetric startup warning: without deps.auth, every request is treated as the demo principal (ANONYMOUS),
  // so capability issuance, governance authorization, and audit records are all attributed to one shared
  // identity rather than the real caller. Fine for local development/demos, dangerous left unwired in production.
  if (deps.auth == null) {
    console.warn(
      "[kohaku] deps.auth is not wired. Every request will be treated as the demo principal (ANONYMOUS). " +
        "In production, wiring deps.auth to real authentication is mandatory.",
    );
  }
  const getPrincipal = async (c: Context): Promise<Principal> => (await deps.auth?.(c)) ?? ANONYMOUS;

  /**
   * Governance/audit-plane authorization. If deps.authorizeGovernance is wired, it is checked, and on rejection
   * returns 403 CAPABILITY_DENIED (does not grow the SPEC error codes). A null return means "allowed (proceed)".
   * **If not wired, null = allowed without authorization. Governance-plane authorization is a product
   * responsibility, and in production either wiring this hook or protecting it with external middleware is mandatory
   * (when not wired, it is authorization-less).**
   */
  const requireGovernance = async (
    c: Context,
    // kind is restricted to the actual set (GovernanceOperationKind). A typo on the route side is rejected at compile time.
    // It is naturally assignable as a narrower type to the authorizeGovernance hook's signature (kind: string).
    operation: GovernanceOperation,
  ): Promise<Response | null> => {
    if (deps.authorizeGovernance == null) return null;
    const principal = await getPrincipal(c);
    const tenant = await resolveTenant(c, deps);
    const allowed = await deps.authorizeGovernance(principal, operation, tenant);
    if (allowed) return null;
    return c.json(
      errorBody("CAPABILITY_DENIED", `governance operation "${operation.kind}" was not authorized`),
      403,
    );
  };

  /**
   * A simple mutex that serializes the read-modify-write of the promotion family (approve / reject / withdraw /
   * actions and evaluate's auto-nominate) **per tenant** within the process. The service-side act /
   * evaluateAndList docstrings state that "serialization is the caller's responsibility"; without serialization,
   * concurrent approves on the same artifact interleave (double onPublish firing), and additionally evaluateAndList
   * can write back an already-approved state from a stale snapshot (lost update). The key is coarsened to per-tenant
   * rather than (tenant, artifactId) because evaluateAndList scans all artifacts within a tenant and a per-artifact
   * lock cannot cover it (at governance-plane operation frequency, the coarse granularity is not a problem).
   * The lock is scoped to each createKohakuRoutes call (= app instance).
   */
  const promotionMutex = createKeyedMutex();

  const ctx: RouteContext = {
    deps,
    getPrincipal,
    requireGovernance,
    withPromotionLock: (tenant, fn) => promotionMutex(tenant ?? "", fn),
  };

  registerComposeRoutes(app, ctx);
  registerBindingRoutes(app, ctx);
  registerGovernanceRoutes(app, ctx);
  registerPromotionRoutes(app, ctx);
  registerFixationRoutes(app, ctx);

  // --- Catalog (for capability negotiation / debugging) ---
  app.get("/catalog", async (c) => {
    // The catalog is per-tenant. Since promoted components are independent per tenant, return that tenant's
    // catalog (base if catalogFor is not wired. Aligned with the catalog compose uses, to avoid capability-negotiation mismatch).
    const tenant = await resolveTenant(c, deps);
    const catalog = withTenantCatalog(deps.compose, tenant).catalog;
    const defs = catalog.list().map((def) => ({
      type: def.type,
      version: def.version,
      description: def.description,
      capabilities: def.capabilities,
      implementation: def.implementation ?? { kind: "native" },
      propsSchema: cachedPropsJsonSchema(def),
    }));
    return c.json({ components: defs, catalogVersion: catalog.fingerprint });
  });

  return app;
}
