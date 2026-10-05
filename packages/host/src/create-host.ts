import { randomBytes } from "node:crypto";
import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import {
  type ComposeContext,
  type ComposeObserver,
  type ComposePolicy,
  composeObservers,
} from "@kohaku-ui/composer";
import type { QueryRef } from "@kohaku-ui/data-binding";
import { createConsoleErrorReporter } from "@kohaku-ui/host-core";
import { createKohakuRoutes, type KohakuHostDeps } from "@kohaku-ui/host-rest";
import type { IntentDef } from "@kohaku-ui/intents";
import {
  createActionAuditRecorder,
  createLineage,
  createViewRecorder,
  type Lineage,
} from "@kohaku-ui/lineage";
import type { LlmPort } from "@kohaku-ui/llm";
import { coreCatalog, type ResolvedCatalog, resolveCatalog } from "@kohaku-ui/registry";
import {
  createIntentCatalog,
  createLlmSemanticPort,
  type IntentCatalogLike,
  type LlmSemanticPortOptions,
} from "@kohaku-ui/semantic-llm";
import type {
  AuthzPort,
  DataShape,
  DomainPort,
  QueryHandle,
  SemanticPort,
  StoragePort,
} from "@kohaku-ui/spec-core";
import { createMemoryStoragePort } from "@kohaku-ui/storage-memory";
import { Hono } from "hono";

/** Where `createKohakuHost`'s `app` mounts `createKohakuRoutes` by default (overridable via `basePath`). */
const DEFAULT_BASE_PATH = "/api/kohaku";

export interface CreateKohakuHostOptions {
  /** The product's DomainPort (listOperations / invoke). Required. */
  domain: DomainPort;
  /** The only source allowed for `query://<source>/...` references. Required. */
  querySource: string;
  /**
   * Required (never defaulted to a fake/env-derived LLM -- see README's `createLlmFromEnv()` example).
   * Ignored for nothing: even a custom `semantic` still needs `llm` for L1/L2 UI generation
   * (`ComposeContext.llm`).
   */
  llm: LlmPort;

  /**
   * Intent catalog for the default (LLM-backed) SemanticPort (`createLlmSemanticPort`). Ignored when
   * `semantic` is supplied directly. Required, together with `dataVersion`, when it is not.
   */
  intents?: IntentDef[] | IntentCatalogLike;
  /** Required together with `intents` (see `LlmSemanticPortOptions.dataVersion`). Ignored when `semantic` is supplied. */
  dataVersion?: (handle: QueryHandle) => Promise<string> | string;
  /** Optional, passed through to the default SemanticPort (see `LlmSemanticPortOptions.describeShape`). Ignored when `semantic` is supplied. */
  describeShape?: (ref: QueryRef) => DataShape | null;
  /**
   * Optional, passed through to the default SemanticPort (see `LlmSemanticPortOptions.fallbackIntent`): the
   * Intent served when a question maps to nothing in the catalog. Ignored when `semantic` is supplied.
   */
  fallbackIntent?: LlmSemanticPortOptions["fallbackIntent"];
  /**
   * Optional, passed through to the default SemanticPort (see `LlmSemanticPortOptions.rules`): product-specific
   * deterministic rules consulted before the LLM. Ignored when `semantic` is supplied.
   */
  rules?: LlmSemanticPortOptions["rules"];

  /** Default: `createMemoryStoragePort()`. */
  storage?: StoragePort;
  /** Default: `createHmacAuthzPort(secret)` -- see `capabilitySecret` / `dev` for how `secret` is resolved. */
  authz?: AuthzPort;
  /** Default: `createLlmSemanticPort({ llm, catalog: intents, dataVersion, describeShape })`. */
  semantic?: SemanticPort;
  /** The component registry catalog (`ComposeContext.catalog`). Default: `resolveCatalog(coreCatalog)`. */
  catalog?: ResolvedCatalog;
  /** `ComposeContext.policy`. Default: unset (composer's own defaults apply). */
  policy?: ComposePolicy;
  /**
   * `ComposeContext.policyFor`: per-session policy resolution, e.g. a Policy as Code runtime's `policyFor`
   * (`createPolicyRuntime(...).policyFor`, see the user guide's policy section). Default: unset.
   */
  policyFor?: ComposeContext["policyFor"];
  /**
   * An extra `ComposeObserver` (e.g. `@kohaku-ui/otel`'s `createOtelComposeObserver`). It is combined with the
   * console error reporter's `onError` through composer's `composeObservers`, so wiring one never silences the
   * default stderr line. Default: unset (the reporter alone).
   */
  observer?: ComposeObserver;

  /**
   * HMAC signing secret for the default `authz`. Falls back to the `KOHAKU_CAPABILITY_SECRET` environment
   * variable when unset. Ignored when `authz` is supplied directly (no secret is demanded in that case).
   */
  capabilitySecret?: string;
  /** Overrides the REST profile's `KohakuHostDeps.onError`. Default: `createConsoleErrorReporter({ debug }).host`. */
  onError?: KohakuHostDeps["onError"];
  /**
   * The View Lineage recorder handed to the REST profile (and, through `attachKohakuMcp`, to the MCP profile).
   * Default: `createViewRecorder(createLineage({ storage }))` over the facade's own `storage`, so every compose
   * is recorded and `kohaku explain` / DevTools / evidence have something to read. Pass your own recorder to
   * replace it, or `false` to record nothing.
   */
  recorder?: KohakuHostDeps["recorder"] | false;
  /**
   * The governed-Action audit recorder handed to the REST profile (and, through `attachKohakuMcp`, to the MCP
   * profile). Default: `createActionAuditRecorder(lineage)` over the same lineage instance as `recorder`, so
   * every gated `POST /binding/action` outcome except `invalid` (which records nothing) lands as an `action.*`
   * event (`action.invoked` / `action.denied` / `action.approvalRequested` / `action.approved`). Pass your own
   * to replace it, or `false` to record nothing.
   */
  actionAuditRecorder?: KohakuHostDeps["actionAuditRecorder"] | false;
  /**
   * Every other `KohakuHostDeps` field, passed through to `createKohakuRoutes` unchanged: `auth` / `tenant`
   * (JWT and multi-tenant resolution), `approvals` / `actionEffects` (governed Actions), `rateLimiter` /
   * `onRateLimited`, `authorizeGovernance`, `promotions` / `fixations`, ... `approvals`, `rateLimiter`,
   * `actionEffects` and `onRateLimited` are also exposed as `KohakuHost.governance`, which `attachKohakuMcp`
   * uses as its defaults so both profiles enforce one configuration. The fields this facade
   * owns (`compose`, `domain`, `authz`, `querySource`) and the ones it has a dedicated option for (`onError`,
   * `recorder`, `actionAuditRecorder`) are excluded so there is exactly one way to set each.
   */
  routes?: Partial<
    Omit<
      KohakuHostDeps,
      "compose" | "domain" | "authz" | "querySource" | "onError" | "recorder" | "actionAuditRecorder"
    >
  >;
  /** Verbose mode for the default console error reporter (see `createConsoleErrorReporter`'s `debug` option). Default false. */
  debug?: boolean;
  /**
   * Development mode. Two effects, both for local development only:
   * 1. When no capability secret can be resolved (see `capabilitySecret`), generates a temporary random one for
   *    this process instead of throwing, and warns on `console.warn`. Never enable this in production: the
   *    secret is not persisted, so it changes on every restart and invalidates every capability token issued
   *    before it. This only matters when no secret is given; a project that always sets
   *    `KOHAKU_CAPABILITY_SECRET` is unaffected by this half of `dev`.
   * 2. Forwarded to `createKohakuRoutes` (`KohakuHostDeps.dev`), which folds its two production-facing startup
   *    warnings (no `authorizeGovernance`, no `auth`) into one `console.warn` line. No behavior changes.
   *    `routes.dev` overrides this forwarded value.
   *
   * `dev` turns on both effects. To fold only the warnings and keep the missing-secret throw, pass
   * `routes: { dev: true }` instead (this is what `kohaku init`'s generated `server/ports.ts` does).
   */
  dev?: boolean;
  /** Where `app` mounts `createKohakuRoutes`. Default `"/api/kohaku"`. */
  basePath?: string;
}

export interface KohakuHost {
  /** A Hono app with `createKohakuRoutes` already mounted at `basePath`. Add your own routes on it freely. */
  app: Hono;
  /** The assembled ComposeContext, in case you need to `compose()` outside of host-rest (e.g. from a script). */
  compose: ComposeContext;
  /** The resolved Ports (yours, when overridden; the default otherwise) -- useful for `@kohaku-ui/host/mcp`. */
  ports: { storage: StoragePort; authz: AuthzPort; semantic: SemanticPort; domain: DomainPort };
  /** The allowed source for `query://<source>/...` references, as given to `createKohakuHost`. Also consumed by `@kohaku-ui/host/mcp`'s `attachKohakuMcp`. */
  querySource: string;
  /**
   * The View Lineage service over `ports.storage` (the one the default `recorder` writes into); pass it to
   * `createActionAuditRecorder` / `createFixations` / `summarizeLineage` when wiring `routes`. Always present, even
   * when `recorder` is overridden or disabled.
   */
  lineage: Lineage;
  /** The ViewRecorder in effect (the default lineage one, yours, or undefined when disabled). `attachKohakuMcp` wires it into the MCP profile too. */
  recorder: KohakuHostDeps["recorder"];
  /** The ActionAuditRecorder in effect (the default lineage one, yours, or undefined when disabled). `attachKohakuMcp` wires it into the MCP profile too. */
  actionAuditRecorder: KohakuHostDeps["actionAuditRecorder"];
  /** The console error reporter's debug flag as given to `createKohakuHost`; `attachKohakuMcp` reuses it for the MCP profile's default `onError`. */
  debug: boolean;
  /**
   * The governance configuration in effect on the REST profile (`routes.approvals` / `routes.rateLimiter` /
   * `routes.actionEffects`, and `onRateLimited`: yours, or a console line through the default error
   * reporter). `attachKohakuMcp` wires these into the MCP profile as defaults (its own `deps` override), so a
   * rate limit or an approval port configured once applies on both. Absent fields are simply unwired.
   */
  governance: HostGovernance;
}

/** The REST-profile governance fields the facade shares with the MCP profile; see `KohakuHost.governance`. */
export interface HostGovernance {
  approvals?: KohakuHostDeps["approvals"];
  rateLimiter?: KohakuHostDeps["rateLimiter"];
  actionEffects?: KohakuHostDeps["actionEffects"];
  onRateLimited: NonNullable<KohakuHostDeps["onRateLimited"]>;
}

function resolveIntentCatalog(intents: IntentDef[] | IntentCatalogLike): IntentCatalogLike {
  return Array.isArray(intents) ? createIntentCatalog(intents) : intents;
}

function resolveSemantic(options: CreateKohakuHostOptions): SemanticPort {
  if (options.semantic != null) return options.semantic;
  if (options.intents == null) {
    throw new Error(
      "createKohakuHost: provide either `semantic` (a SemanticPort) or `intents` (IntentDef[] / an " +
        "IntentCatalogLike) so a default LLM-backed SemanticPort can be built.",
    );
  }
  if (options.dataVersion == null) {
    throw new Error(
      "createKohakuHost: `dataVersion` is required together with `intents` to build the default SemanticPort.",
    );
  }
  return createLlmSemanticPort({
    llm: options.llm,
    catalog: resolveIntentCatalog(options.intents),
    dataVersion: options.dataVersion,
    ...(options.describeShape != null ? { describeShape: options.describeShape } : {}),
    ...(options.fallbackIntent != null ? { fallbackIntent: options.fallbackIntent } : {}),
    ...(options.rules != null ? { rules: options.rules } : {}),
  });
}

/** Builds the default HMAC AuthzPort's signing secret, honoring `dev`'s fallback -- see its own doc comment. */
function resolveAuthz(options: CreateKohakuHostOptions): AuthzPort {
  if (options.authz != null) return options.authz;
  const secret = options.capabilitySecret ?? process.env["KOHAKU_CAPABILITY_SECRET"]?.trim();
  if (secret != null && secret !== "") return createHmacAuthzPort(secret);
  if (options.dev === true) {
    console.warn(
      "[kohaku] no capability secret was set (KOHAKU_CAPABILITY_SECRET / `capabilitySecret`); using a " +
        "freshly generated one for this process only, because `dev: true` was passed. Every capability " +
        "issued before a restart becomes invalid, and this is never safe in production -- set a real " +
        "secret instead (`kohaku init` generates one into a project's .env).",
    );
    return createHmacAuthzPort(randomBytes(32).toString("base64url"));
  }
  throw new Error(
    "createKohakuHost: no capability secret. Set the KOHAKU_CAPABILITY_SECRET environment variable " +
      "(kohaku init generates one into a project's .env), pass `capabilitySecret`, pass your own `authz`, " +
      "or pass `dev: true` for a temporary development-only secret.",
  );
}

/**
 * Wires the default Port implementations into `@kohaku-ui/host-rest`'s `createKohakuRoutes` in one call: a
 * minimal host is `createKohakuHost({ domain, querySource, llm, intents, dataVersion })`, mounted at
 * `/api/kohaku` and ready to serve. Every default is independently overridable (`storage`, `authz`,
 * `semantic`, `catalog`); overriding one skips building its own default (e.g. passing `authz` means no
 * capability secret is ever demanded, and passing `semantic` means `intents` / `dataVersion` /
 * `describeShape` are never consulted).
 *
 * `createConsoleErrorReporter({ debug })` is wired into both the REST profile's `onError` and the compose
 * observer's `onError` by default, so failures are visible on stderr out of the box; pass your own `onError`
 * to replace the REST-facing half once you have real logging/metrics. View Lineage and action-audit recorders over
 * `storage` are wired by default too (see `recorder` / `actionAuditRecorder`), and `routes` passes every remaining `KohakuHostDeps` field (`auth`,
 * `tenant`, `approvals`, `rateLimiter`, ...) through to `createKohakuRoutes`.
 *
 * `kohaku init` and `kohaku scaffold ports` both build on this (see design.md #52). For MCP, see the
 * `@kohaku-ui/host/mcp` subpath (`attachKohakuMcp`) -- kept separate so a REST-only consumer never needs
 * `@modelcontextprotocol/server`.
 */
export function createKohakuHost(options: CreateKohakuHostOptions): KohakuHost {
  const storage = options.storage ?? createMemoryStoragePort();
  const authz = resolveAuthz(options);
  const semantic = resolveSemantic(options);
  const catalog = options.catalog ?? resolveCatalog(coreCatalog);
  const debug = options.debug ?? false;
  const errorReporter = createConsoleErrorReporter({ debug });
  const lineage = createLineage({ storage });
  const recorder = options.recorder === false ? undefined : (options.recorder ?? createViewRecorder(lineage));
  const actionAuditRecorder =
    options.actionAuditRecorder === false
      ? undefined
      : (options.actionAuditRecorder ?? createActionAuditRecorder(lineage));

  const compose: ComposeContext = {
    catalog,
    semantic,
    storage,
    llm: options.llm,
    ...(options.policy != null ? { policy: options.policy } : {}),
    ...(options.policyFor != null ? { policyFor: options.policyFor } : {}),
    observer: composeObservers({ onError: errorReporter.compose }, options.observer),
  };

  const governance: HostGovernance = {
    ...(options.routes?.approvals != null ? { approvals: options.routes.approvals } : {}),
    ...(options.routes?.rateLimiter != null ? { rateLimiter: options.routes.rateLimiter } : {}),
    ...(options.routes?.actionEffects != null ? { actionEffects: options.routes.actionEffects } : {}),
    onRateLimited:
      options.routes?.onRateLimited ??
      ((info) => {
        errorReporter.host({
          endpoint: `rate limit (${info.routeClass})`,
          requestId: info.requestId,
          error: new Error(`rate limited${info.principal != null ? ` (principal ${info.principal})` : ""}`),
        });
      }),
  };

  const app = new Hono();
  app.route(
    options.basePath ?? DEFAULT_BASE_PATH,
    createKohakuRoutes({
      dev: options.dev === true,
      ...options.routes,
      compose,
      domain: options.domain,
      authz,
      querySource: options.querySource,
      onError: options.onError ?? errorReporter.host,
      onRateLimited: governance.onRateLimited,
      ...(recorder != null ? { recorder } : {}),
      ...(actionAuditRecorder != null ? { actionAuditRecorder } : {}),
    }),
  );

  return {
    app,
    compose,
    ports: { storage, authz, semantic, domain: options.domain },
    querySource: options.querySource,
    lineage,
    recorder,
    actionAuditRecorder,
    debug,
    governance,
  };
}
