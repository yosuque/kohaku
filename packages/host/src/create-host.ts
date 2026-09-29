import { randomBytes } from "node:crypto";
import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import type { ComposeContext, ComposePolicy } from "@kohaku-ui/composer";
import type { QueryRef } from "@kohaku-ui/data-binding";
import { createConsoleErrorReporter } from "@kohaku-ui/host-core";
import { createKohakuRoutes, type KohakuHostDeps } from "@kohaku-ui/host-rest";
import type { IntentDef } from "@kohaku-ui/intents";
import { createLineage, createViewRecorder, type Lineage } from "@kohaku-ui/lineage";
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
   * Every other `KohakuHostDeps` field, passed through to `createKohakuRoutes` unchanged: `auth` / `tenant`
   * (JWT and multi-tenant resolution), `approvals` / `actionAuditRecorder` / `actionEffects` (governed
   * Actions), `rateLimiter`, `authorizeGovernance`, `promotions` / `fixations`, ... The fields this facade
   * owns (`compose`, `domain`, `authz`, `querySource`) and the ones it has a dedicated option for (`onError`,
   * `recorder`) are excluded so there is exactly one way to set each.
   */
  routes?: Partial<
    Omit<KohakuHostDeps, "compose" | "domain" | "authz" | "querySource" | "onError" | "recorder">
  >;
  /** Verbose mode for the default console error reporter (see `createConsoleErrorReporter`'s `debug` option). Default false. */
  debug?: boolean;
  /**
   * Development convenience: when true and no capability secret can be resolved (see `capabilitySecret`),
   * generates a temporary random one for this process instead of throwing, and warns on `console.warn`. Never
   * enable this in production -- a secret that changes every restart invalidates every capability token
   * issued before the restart, and a fresh one is trivially guessable by nobody only because nobody else
   * knows it either (it is not persisted anywhere).
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
  /** The console error reporter's debug flag as given to `createKohakuHost`; `attachKohakuMcp` reuses it for the MCP profile's default `onError`. */
  debug: boolean;
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
 * to replace the REST-facing half once you have real logging/metrics. A View Lineage recorder over `storage` is
 * wired by default too (see `recorder`), and `routes` passes every remaining `KohakuHostDeps` field (`auth`,
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

  const compose: ComposeContext = {
    catalog,
    semantic,
    storage,
    llm: options.llm,
    ...(options.policy != null ? { policy: options.policy } : {}),
    observer: { onError: errorReporter.compose },
  };

  const app = new Hono();
  app.route(
    options.basePath ?? DEFAULT_BASE_PATH,
    createKohakuRoutes({
      ...options.routes,
      compose,
      domain: options.domain,
      authz,
      querySource: options.querySource,
      onError: options.onError ?? errorReporter.host,
      ...(recorder != null ? { recorder } : {}),
    }),
  );

  return {
    app,
    compose,
    ports: { storage, authz, semantic, domain: options.domain },
    querySource: options.querySource,
    lineage,
    recorder,
    debug,
  };
}
