import type { CacheHint, ServerOptions } from "@modelcontextprotocol/server";

/**
 * MCP 2026-07-28 (SEP-2549) response caching: `ttlMs`/`cacheScope` hints for this profile's
 * cacheable results. Additive — a hint only fills in when the handler-produced result does not
 * already carry its own `ttlMs`/`cacheScope` (the SDK's per-field resolution order, see
 * `ServerOptions.cacheHints`'s own doc comment), and an unconfigured hint keeps today's
 * conservative defaults (`ttlMs: 0`, `cacheScope: 'private'`).
 *
 * `ttlMs`/`cacheScope` for `tools/list` and `resources/list` deliberately match the Python port's
 * `_LIST_RESULT_TTL_MS` / `_LIST_RESULT_CACHE_SCOPE` (`python/kohaku/src/kohaku/host_mcp/server.py`)
 * so both implementations agree on the wire.
 */
export const KOHAKU_MCP_LIST_CACHE_HINT: CacheHint = {
  /**
   * 60s. This profile's tool set is otherwise static per process (see `AttachOptions.intentTools`'s
   * doc comment — a newly promoted Intent only becomes a new tool on the next process restart), so a
   * client is never more than a minute behind a tool-set change that *can* happen without a restart
   * (none, today) while still saving repeated `tools/list`/`resources/list` round-trips within one
   * session. `resources/list` is bundled under the same hint since this profile's only listed resource
   * (`ui://kohaku/renderer.html`) is equally static per process.
   */
  ttlMs: 60_000,
  /**
   * `'private'`: conservative default, matching Python. Nothing about `tools/list`/`resources/list`
   * actually varies per caller in this profile (every session sees the identical tool/resource set),
   * so `'public'` would not be technically wrong — but this repo has no shared MCP cache in front of
   * it to verify against, so there is nothing to gain from claiming shared-cache safety here.
   */
  cacheScope: "private",
};

/**
 * Ready-to-spread `ServerOptions.cacheHints` for this profile's list operations. `cacheHints` is a
 * constructor-only field of SDK v2's `McpServer` (no post-construction setter exists), and
 * `attachKohakuToMcpServer` below receives an already-constructed `McpServer` from its caller rather
 * than constructing one itself — so, unlike `RENDERER_RESOURCE_CACHE_HINT` (attached directly via
 * this package's own `registerResource(..., {cacheHint})` call), host-mcp-apps cannot wire this value
 * into the server on its own. It is exported so the *value* still lives here as the single source of
 * truth (matching Python's `host_mcp` package, and covering any future consumer beyond
 * `apps/sample-mcp`), while the caller that actually constructs the `McpServer`
 * (`apps/sample-mcp/src/setup.ts`) is the one that passes it to the constructor's `cacheHints` option.
 */
export function defaultMcpListCacheHints(): NonNullable<ServerOptions["cacheHints"]> {
  return {
    "tools/list": KOHAKU_MCP_LIST_CACHE_HINT,
    "resources/list": KOHAKU_MCP_LIST_CACHE_HINT,
  };
}

/**
 * Cache hint (SEP-2549) for the shared renderer resource's (`ui://kohaku/renderer.html`)
 * `resources/read` results. TS-only: Python's `read_resource()` decorator offers no "new style"
 * full-`ReadResourceResult` return path the way `list_tools`/`list_resources` do (see
 * `host_mcp/server.py`'s `_read_resource` doc comment), so Python's `resources/read` is never given
 * `ttlMs`/`cacheScope` — see `python/README.md`'s known-differences list.
 *
 * Reasoning:
 * - The renderer bundle is identical across every client of one server process (no per-session
 *   personalization) and, once read, is memoized for the process's lifetime
 *   (`apps/sample-mcp/src/setup.ts`'s `makeRendererHtmlLoader`) — a large (several-hundred-KB), static
 *   asset that changes only when `build:renderer` runs and the process restarts.
 * - There is no content-hashed URI to bust a client's cache on rebuild — `ttlMs` is the only lever
 *   bounding how long a client can keep serving a stale bundle past a redeploy. 5 minutes trades a
 *   meaningfully shorter window than the list hint above against still saving repeat reads of the
 *   bundle within one short session.
 * - `cacheScope` stays `'private'` for the same reason as `KOHAKU_MCP_LIST_CACHE_HINT`: nothing here
 *   verifies a shared cache actually honors SEP-2549, so this does not claim `'public'` safety.
 * - **Distinct from `KOHAKU_MCP_SNAPSHOT_TTL_MS`** (`apps/sample-mcp`'s env var): that TTL governs when
 *   self-contained snapshot HTML files under `.data/snapshots` are deleted from disk. Snapshots are
 *   served over plain HTTP (`/snapshots/*.html`) or returned as a local path — never through MCP's
 *   `resources/read` — so the two TTLs describe unrelated resources today and there is no staleness
 *   interaction to reconcile. Documented here so a future `resources/read` exposure of snapshot
 *   content does not reuse this hint by copy-paste (it would need to stay at or below whatever
 *   `KOHAKU_MCP_SNAPSHOT_TTL_MS` the deployment uses, or a client could still hold a cached read past
 *   the file's deletion from disk).
 */
export const RENDERER_RESOURCE_CACHE_HINT: CacheHint = {
  ttlMs: 5 * 60 * 1000,
  cacheScope: "private",
};
