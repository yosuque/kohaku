import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { createSchemaExtractor } from "@kohaku-ui/evals";
import { createLlmFromEnv } from "@kohaku-ui/llm";
import { createFileStoragePort } from "@kohaku-ui/storage-memory";
import { createApp } from "./app.js";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(APP_DIR, "../../..");

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
const storage = createFileStoragePort(DATA_DIR);
const authz = createHmacAuthzPort(process.env["KOHAKU_CAPABILITY_SECRET"] ?? "dev-secret-change-me");

// createApp is async because it performs startup reconcile (snapshot authority -> projection).
const { app, repo, setShuttingDown } = await createApp({
  llm,
  storage,
  authz,
  // LLM auto-extraction of the promotion schema (advisory prefill in Admin › Promotions). Opt-in at the
  // entry point so the FakeLlm-scripted tests keep their exact response order.
  schemaExtractor: createSchemaExtractor({ llm }),
});

const port = Number(process.env["PORT"] ?? 8787);
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`kohaku sample-api: http://localhost:${info.port}`);
  console.log(`  LLM: ${llm.provider} / ${llm.modelId}`);
  console.log(`  seed: ${repo.records.length} records (${repo.dataVersion()})`);
});

/** Default drain window (ms) for graceful shutdown, overridable via KOHAKU_SHUTDOWN_GRACE_MS. */
const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

/** Parses KOHAKU_SHUTDOWN_GRACE_MS as a positive integer; any other value (unset, non-numeric, <= 0) falls back to the default. */
function shutdownGraceMs(): number {
  const raw = process.env["KOHAKU_SHUTDOWN_GRACE_MS"];
  const parsed = raw != null ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SHUTDOWN_GRACE_MS;
}

/**
 * Extra wait (ms) between flipping readiness to false and actually closing the server. Default 0
 * (behavior unchanged): with no pre-stop wait, a load balancer's next health poll can lose the race against
 * `server.close()` and observe ECONNREFUSED instead of the intended 503, because both happen in the same
 * tick. Set KOHAKU_SHUTDOWN_PRESTOP_MS to the load balancer's health-check interval (or a bit more) so at
 * least one 503 is guaranteed to be observed before connections stop being accepted.
 */
function shutdownPrestopMs(): number {
  const raw = process.env["KOHAKU_SHUTDOWN_PRESTOP_MS"];
  const parsed = raw != null ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

// Graceful shutdown: flip readiness first (so a load balancer polling /api/health stops routing new traffic
// here), then — after an optional pre-stop wait (KOHAKU_SHUTDOWN_PRESTOP_MS) that gives the load balancer a
// chance to actually observe the 503 before connections stop being accepted — stop accepting new connections
// and let in-flight requests drain. Persistence is atomic / already awaited per request, so the drain window
// only matters for open connections (e.g. SSE streams). If they have not finished draining by the grace
// window, log how many connections are still open and force-exit rather than hang indefinitely; a clean drain
// exits 0, a forced one exits 1 (distinguishable in orchestrator logs).
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    setShuttingDown(true);
    const graceMs = shutdownGraceMs();
    const prestopMs = shutdownPrestopMs();
    console.log(
      `kohaku sample-api: received ${signal}, marked not-ready` +
        (prestopMs > 0 ? ` (pre-stop wait ${prestopMs}ms)` : "") +
        `, then draining connections (grace ${graceMs}ms)`,
    );
    setTimeout(() => {
      // Close idle keep-alive sockets immediately rather than waiting for their keep-alive timeout to
      // elapse: server.close() alone only stops accepting *new* connections and waits for every existing
      // one (idle or not) to end before its callback fires, so an idle client sitting on a keep-alive
      // connection would otherwise stall the drain for no reason. ServerType (@hono/node-server) also
      // covers Http2Server/Http2SecureServer, which do not declare this method — this sample only ever
      // serves plain HTTP/1.1, so the `in` check is always true at runtime, but narrows the type safely
      // for the union.
      if ("closeIdleConnections" in server) server.closeIdleConnections();
      server.close(() => process.exit(0));
      setTimeout(() => {
        server.getConnections((err, count) => {
          console.error(
            `kohaku sample-api: shutdown grace period (${graceMs}ms) elapsed with ` +
              `${err != null ? "an unknown number of" : count} connection(s) still open; forcing exit`,
          );
          process.exit(1);
        });
      }, graceMs).unref();
    }, prestopMs).unref();
  });
}
