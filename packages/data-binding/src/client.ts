import { canonicalStringify, type JsonValue, type TabularData } from "@kohaku-ui/spec-core";
import { BindingError } from "./errors.js";
import { formatQueryRef, parseQueryRef, type QueryRef, RESERVED_PARAM_PREFIX } from "./query-ref.js";

export type AbortSignalLike = unknown;

export interface FetchResponseLike {
  status: number;
  body: unknown;
}

/** Function for swapping out the default HTTP fetcher (for tests and the MCP bridge). */
export type BindingFetcher = (
  ref: QueryRef,
  // headers is optional so existing custom fetchers keep compiling unchanged; when present it is the
  // fixed value pinned by the caller for this request (see resolve()'s "pin the auth context" comment).
  init: { capability?: string; headers?: Record<string, string>; signal?: AbortSignalLike },
) => Promise<FetchResponseLike>;

export type ActionFetcher = (
  action: string,
  payload: JsonValue,
  // signal and headers are symmetric with BindingFetcher (writes can also be aborted / auth-pinned per-request).
  init: { capability?: string; headers?: Record<string, string>; signal?: AbortSignalLike },
) => Promise<FetchResponseLike>;

export interface BindingClientConfig {
  /** Mount point of host-rest (e.g. "/api/kohaku"). Not needed when a fetcher is provided. */
  baseUrl?: string;
  /** capability token (obtained from the /compose response). If a function, it is evaluated on every call. */
  capability?: string | (() => string | undefined);
  /**
   * Extra headers that the default fetcher (baseUrl path) attaches to every resolve / action request.
   * Carries things like the multi-tenant x-kohaku-tenant header or a trace ID. Because it is a function it is
   * evaluated on every call (a tenant switch takes effect from the next request). When a custom
   * fetcher / actionFetcher is provided, that is that fetcher's responsibility.
   */
  headers?: () => Record<string, string> | undefined;
  fetcher?: BindingFetcher;
  actionFetcher?: ActionFetcher;
}

export interface ResolveOptions {
  signal?: AbortSignalLike;
  /** The Spec's dataVersion. If it does not match the returned data, throws STALE_VERSION. */
  expectedDataVersion?: string;
  /**
   * Server-side paging. When provided, it is projected onto the reserved parameters `_cursor` / `_limit`
   * and merged into the ref, and the server slices out the page. The cursor opaquely passes the previous
   * response's `TabularData.nextCursor`.
   */
  page?: { cursor?: string; limit?: number };
  /** Server-side sort. Projected onto the reserved parameters `_sort` / `_dir` and merged into the ref. */
  sort?: { key: string; dir: "asc" | "desc" };
}

/**
 * Result of the direct write path (invokeAction). Tells the renderer that the write has staled the
 * currently displayed data, so that distant tables (useBoundData) re-resolve in place (a small loop).
 * - invalidates: `query://` URIs to invalidate (exact match).
 * - refVersions: new per-ref data versions (consistent with the per-reference reconciliation semantics; the target to
 *   reconcile against on re-resolve).
 */
export interface ActionResult {
  result: JsonValue;
  invalidates?: string[];
  refVersions?: Record<string, string>;
}

/**
 * Client for reference-passing data binding: bulk data never passes through the model's context
 * (the reference-passing principle). Resolves a Spec's $ref directly against the API. composer / LLM never
 * touch this package at all (what the LLM assembles is the plumbing, not the water).
 */
export interface BindingClient {
  resolve(ref: string | { $ref: string }, opts?: ResolveOptions): Promise<TabularData>;
  /** Direct write path (presentForm submit / editing operations). Avoids a round-trip through the LLM. */
  invokeAction(action: string, payload: JsonValue, opts?: ActionOptions): Promise<ActionResult>;
}

/** Options for invokeAction (a trailing optional argument, for backward compatibility). */
export interface ActionOptions {
  /** Per-request cancellation. Propagated to actionFetcher's init.signal (symmetric with BindingFetcher). */
  signal?: AbortSignalLike;
}

const runtime = globalThis as unknown as {
  fetch: (
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: unknown;
    },
  ) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;
};

function defaultFetcher(baseUrl: string, extraHeaders: () => Record<string, string>): BindingFetcher {
  return async (ref, init) => {
    // A caller-pinned init.headers wins; fall back to re-evaluating extraHeaders() for direct callers
    // (tests, or a fetcher invoked without going through resolve()'s pinning).
    const headers: Record<string, string> = { ...(init.headers ?? extraHeaders()) };
    if (init.capability != null) headers["Authorization"] = `Bearer ${init.capability}`;
    const res = await runtime.fetch(`${baseUrl}/binding/resolve?ref=${encodeURIComponent(ref.raw)}`, {
      headers,
      signal: init.signal,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  };
}

function defaultActionFetcher(
  baseUrl: string,
  cap: () => string | undefined,
  extraHeaders: () => Record<string, string>,
): ActionFetcher {
  return async (action, payload, init) => {
    const headers: Record<string, string> = {
      ...(init.headers ?? extraHeaders()),
      "content-type": "application/json",
    };
    const capability = cap();
    if (capability != null) headers["Authorization"] = `Bearer ${capability}`;
    const res = await runtime.fetch(`${baseUrl}/binding/action`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action, payload }),
      signal: init.signal,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  };
}

export function createBindingClient(config: BindingClientConfig): BindingClient {
  const capability = (): string | undefined =>
    typeof config.capability === "function" ? config.capability() : config.capability;
  const extraHeaders = (): Record<string, string> => config.headers?.() ?? {};

  const fetcher =
    config.fetcher ?? (config.baseUrl != null ? defaultFetcher(config.baseUrl, extraHeaders) : null);
  if (fetcher == null) {
    throw new BindingError("RESOLVE_FAILED", "either baseUrl or fetcher is required");
  }
  const actionFetcher =
    config.actionFetcher ??
    (config.baseUrl != null ? defaultActionFetcher(config.baseUrl, capability, extraHeaders) : null);

  // In-flight sharing (dedup) for the same $ref. Key = normalized ref + expectedDataVersion.
  // On completion or failure it is always removed in finally (prevents a failure from being cached permanently).
  const inflight = new Map<string, Promise<TabularData>>();

  return {
    async resolve(refInput, opts = {}) {
      const uri = typeof refInput === "string" ? refInput : refInput.$ref;
      let ref: QueryRef;
      try {
        ref = parseQueryRef(uri);
      } catch (e) {
        throw new BindingError("BAD_REF", e instanceof Error ? e.message : String(e));
      }
      // The reserved namespace (leading `_`) is only added via page/sort. Its presence in the $ref itself is a misuse.
      if (Object.keys(ref.params).some((k) => k.startsWith(RESERVED_PARAM_PREFIX))) {
        throw new BindingError("BAD_REF", `reserved parameters (_*) are not allowed in a $ref: ${ref.raw}`);
      }
      // Project page / sort onto reserved parameters and merge/re-canonicalize them into the ref (if unspecified, the ref is unchanged = backward compatible).
      const reserved = reservedFromOptions(opts);
      if (Object.keys(reserved).length > 0) {
        const merged: Omit<QueryRef, "raw"> = {
          source: ref.source,
          path: ref.path,
          params: { ...ref.params, ...reserved },
        };
        ref = { ...merged, raw: formatQueryRef(merged) };
      }

      // Pin the auth context (capability + headers) once, here, before dedup. config.capability /
      // config.headers may be getters whose result changes between concurrent calls (e.g. a tenant
      // switch mid-flight) — evaluating them once, up front, keeps the value used for the dedup
      // fingerprint below and the value `run` actually sends on the wire in agreement (both are
      // evaluated synchronously in the same tick as this call, before any await).
      const cap = capability();
      const hdrs = extraHeaders();

      const run = async (): Promise<TabularData> => {
        const { status, body } = await fetcher(ref, {
          ...(cap != null ? { capability: cap } : {}),
          headers: hdrs,
          ...(opts.signal != null ? { signal: opts.signal } : {}),
        });

        if (status === 401 || status === 403) {
          throw new BindingError("UNAUTHORIZED", `binding resolve denied for ${ref.raw}`, { status });
        }
        if (status === 404) {
          throw new BindingError("REF_NOT_FOUND", `no data source for ${ref.raw}`, { status });
        }
        if (status < 200 || status >= 300) {
          throw new BindingError("RESOLVE_FAILED", `binding resolve failed (${status}) for ${ref.raw}`, {
            status,
          });
        }

        const data = body as TabularData;
        if (data == null || !Array.isArray(data.rows) || !Array.isArray(data.columns)) {
          throw new BindingError("RESOLVE_FAILED", `malformed tabular payload for ${ref.raw}`);
        }
        // We confirmed above that it is an array, but if the element type is left unvalidated, columns with a
        // falsified type reach the renderer (asymmetric with dataVersion validation). Shallowly validate only
        // column.key, which the renderer always references (TabularColumn.key: string). Deep validation (each
        // cell of label/type/rows) is excessive, so we do not do it.
        if (!data.columns.every((c) => typeof (c as { key?: unknown })?.key === "string")) {
          throw new BindingError("RESOLVE_FAILED", `malformed columns for ${ref.raw}`);
        }
        // dataVersion is SHOULD (may be omitted), but if present it must be a string (TabularData.dataVersion: string).
        // Prevents a non-string from reaching the renderer with a falsified type.
        if (data.dataVersion !== undefined && typeof data.dataVersion !== "string") {
          throw new BindingError("RESOLVE_FAILED", `malformed dataVersion for ${ref.raw}`);
        }
        // dataVersion may be omitted by the responder (SHOULD). However, when expectedDataVersion is specified,
        // an omission makes reconciliation impossible, so we fail closed to STALE_VERSION (the intended, deterministic
        // behavior: never silently display data whose staleness cannot be judged).
        if (opts.expectedDataVersion != null && data.dataVersion !== opts.expectedDataVersion) {
          throw new BindingError(
            "STALE_VERSION",
            `data version mismatch: spec=${opts.expectedDataVersion} data=${data.dataVersion}`,
          );
        }
        return data;
      };

      // Requests with a signal are excluded from dedup: sharing an in-flight request would let the leading
      // caller's abort propagate to unrelated waiters (and, conversely, a waiter's abort would have no effect),
      // so on the safe side we run them independently.
      if (opts.signal != null) return run();

      // Dedup key: normalized ref + expectedDataVersion + an auth-context fingerprint (the capability
      // string plus a canonical, key-sorted serialization of the headers object). Without the
      // fingerprint, two concurrent resolves of the same ref under different auth contexts (e.g. tenant
      // A's resolve still in flight when the same client instance switches to tenant B and resolves the
      // same ref) would collide on the same key, and the second caller would silently receive the first
      // caller's in-flight response instead of its own. Headers are passed to `run` (and from there to
      // `fetcher`) as the same fixed `hdrs` value used here, so the dedup key and what actually goes on
      // the wire are structurally guaranteed to agree — not merely coincidentally equal within one tick.
      // NOTE: a custom `fetcher` / `actionFetcher` may still choose to ignore `init.headers` and consult
      // config.headers itself (see the headers doc on BindingClientConfig), in which case this
      // fingerprint's headers component may not reflect what actually goes on the wire; dedup safety
      // there rests on the `capability` half plus whatever auth signal the custom fetcher itself keys on.
      const key = `${ref.raw} ${opts.expectedDataVersion ?? ""} ${cap ?? ""} ${canonicalStringify(hdrs)}`;
      const existing = inflight.get(key);
      if (existing != null) return existing;
      // Whether it succeeds or fails, once settled we always remove it from the Map (errors propagate to each waiter awaiting shared).
      const shared = run().finally(() => inflight.delete(key));
      inflight.set(key, shared);
      return shared;
    },

    async invokeAction(action, payload, opts = {}) {
      if (actionFetcher == null) {
        throw new BindingError("RESOLVE_FAILED", "action fetcher is not configured");
      }
      // Pin capability + headers once, here, before the await (same rationale as resolve()'s pinning
      // above): config.capability / config.headers may be getters, and fixing their value up front keeps
      // it in agreement with whatever the caller inspects about this call after it returns.
      const cap = capability();
      const hdrs = extraHeaders();
      const { status, body } = await actionFetcher(action, payload, {
        ...(cap != null ? { capability: cap } : {}),
        headers: hdrs,
        ...(opts.signal != null ? { signal: opts.signal } : {}),
      });
      if (status === 401 || status === 403) {
        throw new BindingError("UNAUTHORIZED", `action "${action}" denied`, { status });
      }
      if (status < 200 || status >= 300) {
        throw new BindingError("RESOLVE_FAILED", `action "${action}" failed (${status})`, { status });
      }
      return parseActionResult(body);
    },
  };
}

/** Projects ResolveOptions' page / sort onto query:// reserved parameters (leading `_`). */
function reservedFromOptions(opts: ResolveOptions): Record<string, string> {
  const reserved: Record<string, string> = {};
  if (opts.page?.cursor != null) reserved["_cursor"] = opts.page.cursor;
  if (opts.page?.limit != null) reserved["_limit"] = String(opts.page.limit);
  if (opts.sort != null) {
    reserved["_sort"] = opts.sort.key;
    reserved["_dir"] = opts.sort.dir;
  }
  return reserved;
}

/**
 * Shapes the /binding/action response body into an ActionResult.
 * If the response has the form `{ result, invalidates?, refVersions? }`, it is adopted as-is;
 * otherwise the whole body is wrapped as result (backward compatible with hosts that have not wired up actionEffects).
 */
function parseActionResult(body: unknown): ActionResult {
  if (body != null && typeof body === "object" && "result" in body) {
    const b = body as { result: JsonValue; invalidates?: unknown; refVersions?: unknown };
    const out: ActionResult = { result: b.result };
    if (Array.isArray(b.invalidates) && b.invalidates.every((x) => typeof x === "string")) {
      out.invalidates = b.invalidates as string[];
    }
    if (b.refVersions != null && typeof b.refVersions === "object" && !Array.isArray(b.refVersions)) {
      const entries = Object.entries(b.refVersions as Record<string, unknown>).filter(
        ([, v]) => typeof v === "string",
      ) as [string, string][];
      if (entries.length > 0) out.refVersions = Object.fromEntries(entries);
    }
    return out;
  }
  return { result: (body ?? null) as JsonValue };
}

export {
  formatQueryRef,
  parseQueryRef,
  type QueryRef,
  QueryRefError,
  RESERVED_PARAM_PREFIX,
  type SplitRef,
  splitReservedParams,
} from "./query-ref.js";
