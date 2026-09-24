import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type ServerType, serve } from "@hono/node-server";
import { createSchemaExtractor } from "@kohaku-ui/evals";
import { createLlmFromEnv } from "@kohaku-ui/llm";
import { createJwtRequestIdentity } from "./app/request-identity.js";
import { createGracefulShutdownHandler, shutdownGraceMs } from "./app/shutdown.js";
import { createApp } from "./app.js";
import { createPortsFromEnv } from "./ports/from-env.js";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(APP_DIR, "../../..");

/**
 * Extra wait (ms) between flipping readiness to false and actually closing the server. Default 0
 * (behavior unchanged): with no pre-stop wait, a load balancer's next health poll can lose the race against
 * `server.close()` and observe ECONNREFUSED instead of the intended 503, because both happen in the same
 * tick. Set KOHAKU_SHUTDOWN_PRESTOP_MS to the load balancer's health-check interval (or a bit more) so at
 * least one 503 is guaranteed to be observed before connections stop being accepted. Only sample-api's REST
 * entry point has a readiness endpoint worth protecting this way, so this stays local (not shared).
 */
export function shutdownPrestopMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["KOHAKU_SHUTDOWN_PRESTOP_MS"];
  const parsed = raw != null ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** Parses KOHAKU_PROMOTION_SCHEMA_SUGGEST as a boolean-ish flag; only the literal "0" disables it (default on). */
export function schemaSuggestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["KOHAKU_PROMOTION_SCHEMA_SUGGEST"] !== "0";
}

/** Default per-call extraction budget for the promotion schema suggester (matches @kohaku-ui/evals's own default). */
const DEFAULT_SCHEMA_SUGGEST_TIMEOUT_MS = 20_000;

/** Parses KOHAKU_PROMOTION_SCHEMA_SUGGEST_TIMEOUT_MS as a positive integer; any other value falls back to the default. */
export function schemaSuggestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["KOHAKU_PROMOTION_SCHEMA_SUGGEST_TIMEOUT_MS"];
  const parsed = raw != null ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SCHEMA_SUGGEST_TIMEOUT_MS;
}

async function main(): Promise<void> {
  // Read .env from the repository root (if absent, environment variables only)
  for (const envPath of [join(REPO_ROOT, ".env"), join(APP_DIR, "../.env")]) {
    if (existsSync(envPath)) {
      process.loadEnvFile(envPath);
      break;
    }
  }

  // KOHAKU_DATA_DIR overrides the persistence directory (e.g. a mktemp'd directory for CI/conformance runs so
  // they never touch the checked-out repo's local demo state; mirrors python/examples/sales-api's KOHAKU_DATA_DIR).
  const DATA_DIR = process.env["KOHAKU_DATA_DIR"] ?? join(APP_DIR, "../.data");
  const llm = createLlmFromEnv();
  // One shared connection for storage + the revocation store (a no-op distinction for file/memory; for
  // redis/postgres this opens exactly one client/pool instead of one each — see createPortsFromEnv's doc).
  const ports = createPortsFromEnv(process.env, { dataDir: DATA_DIR });
  // Fail fast: with a redis/postgres backend, an unreachable server otherwise surfaces only on the first
  // request (or, before storage-redis's fail-fast fix, hangs the caller indefinitely). Exit clearly at
  // startup instead (a no-op for file/memory -- see PortsFromEnv.ready's doc comment).
  try {
    await ports.ready();
  } catch (error) {
    console.error(
      `kohaku sample-api: storage backend (${ports.kinds.storage}) is not ready: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  // createApp is async because it performs startup reconcile (snapshot authority -> projection).
  const { app, repo, setShuttingDown } = await createApp({
    llm,
    storage: ports.storage,
    authz: ports.authz,
    ...(ports.identity != null ? { identity: createJwtRequestIdentity(ports.identity) } : {}),
    // The demo bump-data-version route is on by default for the header-based demo identity (ports.identity
    // == null, i.e. KOHAKU_AUTHZ=hmac) and off by default under JWT; KOHAKU_DEMO_ADMIN_ROUTES=1 opts back in
    // (e.g. to exercise it manually against a JWT-protected deployment) — see AppDeps.demoAdminRoutes.
    demoAdminRoutes: process.env["KOHAKU_DEMO_ADMIN_ROUTES"] === "1" || ports.identity == null,
    // LLM auto-extraction of the promotion schema (advisory prefill in Admin › Promotions). Opt-in at the
    // entry point so the FakeLlm-scripted tests keep their exact response order. KOHAKU_PROMOTION_SCHEMA_SUGGEST=0
    // is the kill switch: every LLM-wiring env var carries one so a deployment can shed non-essential LLM
    // spend without shedding compose itself.
    ...(schemaSuggestEnabled()
      ? { schemaExtractor: createSchemaExtractor({ llm, timeoutMs: schemaSuggestTimeoutMs() }) }
      : {}),
  });

  const port = Number(process.env["PORT"] ?? 8787);
  const server: ServerType = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`kohaku sample-api: http://localhost:${info.port}`);
    console.log(`  LLM: ${llm.provider} / ${llm.modelId}`);
    console.log(`  seed: ${repo.records.length} records (${repo.dataVersion()})`);
    console.log(`  storage: ${ports.kinds.storage} / authz: ${ports.kinds.authz}`);
  });

  // Graceful shutdown: flip readiness first (so a load balancer polling /api/health stops routing new traffic
  // here), then — after an optional pre-stop wait (KOHAKU_SHUTDOWN_PRESTOP_MS) that gives the load balancer a
  // chance to actually observe the 503 before connections stop being accepted — stop accepting new connections
  // and let in-flight requests drain, closing the storage/authz backends only once the drain has actually
  // finished. If they have not finished draining by the grace window, log how many connections are still open
  // and force-exit rather than hang indefinitely; a clean drain exits 0, a forced one exits 1 (distinguishable
  // in orchestrator logs). ServerType (@hono/node-server) also covers Http2Server/Http2SecureServer, which do
  // not declare closeIdleConnections — this sample only ever serves plain HTTP/1.1, so it is always present at
  // runtime, but createGracefulShutdownHandler treats it as optional to type the union safely. The handler
  // itself is shared with sample-mcp's http.ts (see app/shutdown.ts's own doc comment).
  const handleShutdown = createGracefulShutdownHandler({
    server,
    ports,
    setShuttingDown,
    graceMs: shutdownGraceMs(),
    prestopMs: shutdownPrestopMs(),
    label: "kohaku sample-api",
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => handleShutdown(signal));
  }
}

// Start listening only when this file is launched directly (tsx src/index.ts), mirroring sample-mcp's
// src/http.ts — this lets the module be imported for its exported (pure) helpers, e.g. from a test, without
// reading env, building a real LLM, or opening a network listener as a side effect of the import.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
