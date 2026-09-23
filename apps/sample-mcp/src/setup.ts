/**
 * Common setup for sample-mcp (used by both stdio and Streamable HTTP).
 *
 * It assembles env loading, createApp (Ports + Composition Service), the View Lineage recorder,
 * and the renderer / snapshot wiring once, and returns a factory (createServer) that
 * "creates a fresh attached McpServer per session".
 *
 * - stdio (src/index.ts) calls createServer() once and connects it to the stdio transport.
 * - Streamable HTTP (src/http.ts) calls createServer() per connection (session) and connects
 *   each to a separate transport. The result of createApp (Ports, .data, catalog) is shared across all sessions.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JwtIdentityResolver } from "@kohaku-ui/authz-jwt";
import {
  attachKohakuToMcpServer,
  defaultMcpListCacheHints,
  intentToolsFromCatalog,
  type McpHostDeps,
} from "@kohaku-ui/host-mcp-apps";
import { createViewRecorder } from "@kohaku-ui/lineage";
import type { LlmPort } from "@kohaku-ui/llm";
import { createLlmFromEnv } from "@kohaku-ui/llm";
import type { AuthzPort, StoragePort } from "@kohaku-ui/spec-core";
import { admitFixationForLocale, createApp } from "@kohaku-ui-sample/api";
// Reuse sample-api's side-effect declarations (via the package's exports subpath)
import { salesActionEffects } from "@kohaku-ui-sample/api/action-effects";
// Reuse sample-api's env-driven adapter selection (via the package's exports subpath) so the MCP profile
// picks the same KOHAKU_STORAGE / KOHAKU_AUTHZ adapters as the REST profile when neither is overridden.
import { createAuthzFromEnv, createStorageFromEnv } from "@kohaku-ui-sample/api/ports/from-env";
import { McpServer } from "@modelcontextprotocol/server";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(APP_DIR, "../../..");

/** Default directory for persistence shared with the Web app (shares promotion / fixation). */
const DEFAULT_DATA_DIR = join(APP_DIR, "../../sample-api/.data");

/**
 * Default retention TTL (ms) for snapshot HTML files under .data/snapshots before the sweep deletes them
 * (each self-contained snapshot is ~1MB and would otherwise accumulate without bound in a busy demo).
 * Overridable via KOHAKU_MCP_SNAPSHOT_TTL_MS.
 */
const DEFAULT_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Sweep cadence (ms) for expired snapshot files. Chosen to match the session idle-TTL sweep's cadence
 * (http.ts's SWEEP_INTERVAL_MS) so both periodic cleanup passes run at the same rate; the two timers are
 * otherwise independent (setup.ts has no dependency on http.ts, and this sweep also runs for the stdio path,
 * which has no session sweep at all).
 */
const SNAPSHOT_SWEEP_INTERVAL_MS = 60 * 1000;

/** Parses KOHAKU_MCP_SNAPSHOT_TTL_MS as a positive integer; any other value (unset, non-numeric, <= 0) falls back to the default. Exported for testability. */
export function snapshotTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["KOHAKU_MCP_SNAPSHOT_TTL_MS"];
  const parsed = raw != null ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SNAPSHOT_TTL_MS;
}

/**
 * Pure function returning the names of files whose mtime is older than `now - ttlMs` (exported for
 * testability; mirrors http.ts's findExpiredSessions).
 */
export function findExpiredSnapshotFiles(
  files: { name: string; mtimeMs: number }[],
  now: number,
  ttlMs: number,
): string[] {
  return files.filter((f) => now - f.mtimeMs > ttlMs).map((f) => f.name);
}

/**
 * Sweeps `dir`, deleting every file whose mtime is older than `ttlMs`. Best-effort throughout: a directory
 * that does not exist yet (no snapshot rendered so far) or a per-file stat/unlink failure (e.g. a concurrent
 * removal) is swallowed rather than aborting the sweep — this is periodic housekeeping, not a request path.
 */
async function sweepSnapshotDir(dir: string, ttlMs: number, now: () => number = Date.now): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const stats = await Promise.all(
    entries.map(async (name) => {
      try {
        const s = await stat(join(dir, name));
        return { name, mtimeMs: s.mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const files: { name: string; mtimeMs: number }[] = [];
  for (const s of stats) if (s != null) files.push(s);
  const expired = findExpiredSnapshotFiles(files, now(), ttlMs);
  await Promise.all(expired.map((name) => unlink(join(dir, name)).catch(() => {})));
}

const RENDERER_PATH = join(APP_DIR, "../dist/renderer/index.html");
const FALLBACK_HTML = `<!DOCTYPE html><html lang="en"><body style="font-family:sans-serif;padding:24px;color:#475569">
The shared renderer has not been built. Run <code>pnpm --filter @kohaku-ui-sample/mcp build:renderer</code>.
</body></html>`;

export interface KohakuMcpSetupOptions {
  /** Override the LLM (FakeLlm in tests; built from env when omitted). */
  llm?: LlmPort;
  /** Override the persistence directory (an mkdtemp temp directory in tests). */
  dataDir?: string;
  /**
   * Base URL for publishing snapshots (scheme + host, no trailing slash. e.g. https://xxx.trycloudflare.com).
   * When specified, kohaku_render_snapshot returns a public URL (`${base}/snapshots/<file>`), so remote MCP
   * (Streamable HTTP) can open snapshots by URL too (http.ts serves them statically under /snapshots).
   * When unspecified (stdio path), it returns a local path (behavior unchanged).
   */
  snapshotBaseUrl?: string;
  /** Override the StoragePort (tests / a caller that already built one). Built from env (KOHAKU_STORAGE) when omitted. */
  storage?: StoragePort;
  /** Override the AuthzPort (tests / a caller that already built one). Built from env (KOHAKU_AUTHZ) when omitted. */
  authz?: AuthzPort;
  /**
   * Per-tool-call principal resolution (e.g. from the HTTP request's own bearer token under KOHAKU_AUTHZ=jwt).
   * Forwarded verbatim to `attachKohakuToMcpServer`'s `McpHostDeps.resolvePrincipal` — see its doc comment for
   * the fallback order (resolvePrincipal → deps.principal → anonymous) and the fail-closed contract (a throw
   * becomes a structured tool error). Left unwired for stdio (one process, one user).
   */
  resolvePrincipal?: McpHostDeps["resolvePrincipal"];
}

export interface KohakuMcpSetup {
  /**
   * Create one attached McpServer. Can be called per session (connection).
   * The result of createApp, the catalog, and the recorder are shared within this setup.
   */
  createServer(): McpServer;
  /** For startup logging. */
  readonly llm: LlmPort;
  /** The persistence directory actually used. */
  readonly dataDir: string;
  /** Directory where snapshot HTML is stored (single source of truth). http.ts uses this as the source for /snapshots static serving. */
  readonly snapshotDir: string;
  /** Present only when storage/authz were resolved from KOHAKU_AUTHZ=jwt (not overridden by `options.authz`): the identity resolver a caller (http.ts) uses to build `resolvePrincipal`. */
  readonly identity?: JwtIdentityResolver;
  /**
   * Resolves once the storage port this setup created from env is ready (a no-op when `options.storage`
   * was supplied, or for a file/memory backend -- see `StorageFromEnv.ready`'s doc comment). http.ts awaits
   * this before listening so an unreachable redis/postgres backend fails startup clearly instead of only
   * surfacing on the first tool call.
   */
  ready(): Promise<void>;
  /** Closes the storage port this setup created from env (a no-op when `options.storage` was supplied). */
  close(): Promise<void>;
}

/**
 * Pure function that decides the snapshot locator (the string returned to the model). Exported for testability.
 * - If snapshotBaseUrl is present, a public URL (`${base}/snapshots/${encodeURIComponent(fileName)}`).
 *   For remote MCP (Streamable HTTP), http.ts serves it statically under /snapshots, so it can be opened by URL.
 * - Otherwise the traditional local path (`join(snapshotDir, fileName)`). The stdio path uses this (behavior unchanged).
 * fileName is "snapshot-<hash>.html". For URL-ification, encodeURIComponent makes the path segment safe
 * (the hash is effectively invariant, but this stays correct for any fileName and round-trips via decodeURIComponent on the serving side).
 */
export function makeSnapshotLocator(args: {
  snapshotBaseUrl?: string;
  snapshotDir: string;
  fileName: string;
}): string {
  if (args.snapshotBaseUrl != null && args.snapshotBaseUrl !== "") {
    return `${args.snapshotBaseUrl}/snapshots/${encodeURIComponent(args.fileName)}`;
  }
  return join(args.snapshotDir, args.fileName);
}

/**
 * Create the renderer HTML loader. To avoid synchronously re-reading the several-hundred-KB bundle
 * on every resource read / snapshot generation, memoize **only successful reads**. On file absence
 * (exists=false), it just returns the fallback and does not cache (so that if build:renderer runs after MCP
 * startup, the next call picks it up).
 * The reader functions (exists / read) are injectable and it is exported for testability (same style as makeSnapshotLocator).
 */
export function makeRendererHtmlLoader(args: {
  exists: () => boolean;
  read: () => string;
  fallback: string;
}): () => string {
  let cache: string | undefined;
  return () => {
    if (cache != null) return cache;
    if (!args.exists()) return args.fallback; // absence is not cached (picks it up if built later)
    cache = args.read();
    return cache;
  };
}

/**
 * Run the common setup once and return a per-session McpServer factory.
 * createApp is async because it reconciles at startup (snapshot authority → projection).
 */
export async function createKohakuMcpSetup(options: KohakuMcpSetupOptions = {}): Promise<KohakuMcpSetup> {
  // When llm is explicitly provided (tests), do not read env. Only in the default production case do we read .env before building.
  let llm: LlmPort;
  if (options.llm != null) {
    llm = options.llm;
  } else {
    loadRepoEnv();
    llm = createLlmFromEnv();
  }
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;

  const storageFromEnv = options.storage != null ? null : createStorageFromEnv(process.env, { dataDir });
  const storage = options.storage ?? storageFromEnv!.storage;
  const authzFromEnv = options.authz != null ? null : createAuthzFromEnv(process.env);
  const authz = options.authz ?? authzFromEnv!.authz;

  const { composeCtx, domain, lineage, fixations, intentCatalog } = await createApp({
    llm,
    storage,
    authz,
  });
  // Also record MCP-side compose in View Lineage (build a recorder from the shared lineage, the same as the REST side).
  // This way MCP usage is also kept as view.composed and merges into the promotion (minUses) / fixation counters and
  // the Admin Lineage timeline ("shares the same persistence as the Web app").
  const recorder = createViewRecorder(lineage);

  // Save location for self-contained snapshot HTML (under the same .data as the Web app; gitignored).
  const SNAPSHOT_DIR = join(dataDir, "snapshots");
  // Periodic mtime-TTL cleanup: each self-contained snapshot is ~1MB and would otherwise accumulate without
  // bound. The timer is unref'd so it never keeps the process alive; it runs for both the stdio and HTTP paths
  // since both write into SNAPSHOT_DIR.
  const snapshotSweepTimer = setInterval(
    () => void sweepSnapshotDir(SNAPSHOT_DIR, snapshotTtlMs()),
    SNAPSHOT_SWEEP_INTERVAL_MS,
  );
  snapshotSweepTimer.unref?.();
  // Finalize the Intent catalog once (core 7 + promoted intents merged from the .data/promotions.json snapshot at startup).
  // Every session's McpServer exposes the same tool set (static at startup).
  const intentTools = intentToolsFromCatalog(intentCatalog.list());

  // Renderer HTML loader that memoizes only successful reads, avoiding synchronous re-reads on every
  // resource read / snapshot generation. Shared across all sessions (createServer) (RENDERER_PATH is fixed).
  const loadRendererHtml = makeRendererHtmlLoader({
    exists: () => existsSync(RENDERER_PATH),
    read: () => readFileSync(RENDERER_PATH, "utf8"),
    fallback: FALLBACK_HTML,
  });

  function createServer(): McpServer {
    const server = new McpServer(
      { name: "kohaku-sales-sample", version: "0.1.0" },
      {
        // MCP 2026-07-28 response caching (SEP-2549): tools/list and resources/list are otherwise
        // static per process (see AttachOptions.intentTools's doc comment), so this sample opts into
        // host-mcp-apps' default list-result cache hint (ttlMs/cacheScope match the Python port — see
        // defaultMcpListCacheHints's doc comment). ServerOptions.cacheHints is only settable at
        // construction (SDK v2 exposes no post-hoc setter), which is why this must live in the
        // McpServer-constructing call site rather than in attachKohakuToMcpServer below; the *values*
        // still live in host-mcp-apps as the single source of truth for any other consumer.
        cacheHints: defaultMcpListCacheHints(),
      },
    );
    attachKohakuToMcpServer(
      server,
      {
        compose: composeCtx,
        domain,
        authz,
        querySource: "sales",
        // Plain read; delivery gating (the demo's EN-only language policy) is shared verbatim with the
        // REST side via fixationAdmit below (host-deps.ts wires the exact same admitFixationForLocale).
        fixationLookup: (intentHash) => storage.getFixation(intentHash),
        fixationAdmit: admitFixationForLocale,
        // Fire the fixation staleness self-healing, the same as the REST side (natural migration over the shared .data).
        fixations,
        // Record to View Lineage symmetrically with the REST side (composed / interacted / fallback), via the
        // same ViewRecorder contract host-rest's host-deps.ts wires (createViewRecorder(lineage) already
        // conforms to it structurally). Surface is "mcp-app", representing the MCP Apps profile.
        recorder,
        // Side-effect declarations for writes (kohaku_action). Shares the same salesActionEffects as the REST side (app.ts),
        // making "annotate's data-version progression → invalidation of currently-displayed references" work symmetrically on the MCP side too.
        actionEffects: salesActionEffects,
        // Per-tool-call principal resolution (e.g. under KOHAKU_AUTHZ=jwt, http.ts derives it from the request's
        // own bearer token). Left unwired by default (every call runs as the anonymous principal — see
        // McpHostDeps.resolvePrincipal's doc comment for the fallback order).
        ...(options.resolvePrincipal != null ? { resolvePrincipal: options.resolvePrincipal } : {}),
      },
      {
        // Use the loader that memoizes only successful reads (on absence, does not cache the FALLBACK each time).
        rendererHtml: async () => loadRendererHtml(),
        // Write the self-contained snapshot HTML (for UI-incapable hosts) into .data/snapshots/.
        // If the renderer is not built, injectSnapshot fails because the placeholder is missing and guides the user to build:renderer.
        // The write always goes to local; the locator returned to the model (public URL or local path) is
        // decided by makeSnapshotLocator (a pure function) based on the presence of snapshotBaseUrl (serving / URL-ification is the host's responsibility).
        snapshotWriter: async (fileName, html) => {
          await mkdir(SNAPSHOT_DIR, { recursive: true });
          await writeFile(join(SNAPSHOT_DIR, fileName), html, "utf8");
          return makeSnapshotLocator({
            snapshotBaseUrl: options.snapshotBaseUrl,
            snapshotDir: SNAPSHOT_DIR,
            fileName,
          });
        },
        // Expose the entire Intent catalog as typed intent tools. Eliminates the single hand-written duplicate and
        // has the SDK generate inputSchema from the Zod params. Tool names normalize the canonical (sales.quarterly_summary, etc.)
        // to the MCP naming constraints (→ sales_quarterly_summary).
        // Promoted ones are "static at startup": an Intent newly promoted on the REST side after MCP startup does not
        // appear as a new tool until this MCP process restarts (MCP finalizes its tool list at connection time; dynamic
        // registerTool + list_changed notification across the shared .data is out of scope for this sample).
        intentTools,
        // UIResource co-emission for mcp-ui legacy host compatibility. It adds about 1MB/result to content, so
        // off by default. Opt in via env only when connecting to a legacy host that does not support SEP-1865 (LibreChat, etc.)
        // (do not enable this for modern hosts = Claude / ChatGPT — the tool-result size limit breaks the widget).
        legacyUiResource: process.env["KOHAKU_MCP_LEGACY_UI"] === "1",
      },
    );
    return server;
  }

  return {
    createServer,
    llm,
    dataDir,
    snapshotDir: SNAPSHOT_DIR,
    identity: authzFromEnv?.identity,
    ready: async () => {
      await storageFromEnv?.ready();
      await authzFromEnv?.ready();
    },
    close: async () => {
      await storageFromEnv?.close();
      await authzFromEnv?.close();
    },
  };
}

/** Read the repository-root .env (env vars only if absent). Called only at real stdio / HTTP startup. */
function loadRepoEnv(): void {
  for (const envPath of [join(REPO_ROOT, ".env")]) {
    if (existsSync(envPath)) {
      process.loadEnvFile(envPath);
      break;
    }
  }
}
