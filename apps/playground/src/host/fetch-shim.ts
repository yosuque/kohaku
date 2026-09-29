/** Anything with the shape of sample-api's `SampleApp.app` (a Hono instance) that this shim actually uses. */
export interface FetchShimTarget {
  fetch(request: Request): Promise<Response> | Response;
}

export interface FetchShimOptions {
  /**
   * The page's origin (`location.origin`), used to decide whether a request is same-origin. Defaults to
   * `globalThis.location`'s origin when running in a real page; a test passes one explicitly (this module
   * has no jsdom/DOM dependency of its own — see fetch-shim.test.ts, which runs under the plain "node"
   * vitest environment the rest of this package uses).
   */
  origin?: string;
  /**
   * Vite's deployed base path (`import.meta.env.BASE_URL`, e.g. `/kohaku/` on a GitHub Pages project
   * site), so `<base>api/*` is recognized the same as `/api/*` at the site root. Defaults to `"/"`.
   */
  base?: string;
  /**
   * Called after a routed `/api/kohaku/compose*` response degraded to composer's deterministic fallback
   * (`spec.provenance.fallback.kind === "generation"` — see `@kohaku-ui/spec-core`'s `ProvenanceSchema`),
   * the one situation in this playground an LLM problem can actually reach: an unrecorded `ReplayLlm` key
   * throws inside compose, and composer's own resilience already turns that into a fallback Spec rather
   * than a hard error — the screen never breaks, but a visitor who typed a free-form question composer.js
   * has no fixture for deserves to know why the result looks generic. Never called for a request outside
   * `/api/kohaku/compose*`, and never lets a body-parsing problem here affect the response actually
   * returned to the caller (best-effort observation only).
   */
  onGenerationFallback?: (info: { from: string; reason: string }) => void;
}

/** A `spec.provenance.fallback` shape worth notifying about (ProvenanceSchema, packages/spec-core). Kept
 * minimal (not importing spec-core's own type) since this file's whole point is having no dependency
 * beyond the Fetch/URL web standard APIs. */
interface ComposeResponseBody {
  spec?: { provenance?: { fallback?: { from?: string; reason?: string; kind?: string } } };
}

/** True only for the compose endpoints (not e.g. /events, /promotions, ...) — the only ones whose response
 * body ever carries a `spec.provenance.fallback`. */
function isComposeEndpoint(pathname: string): boolean {
  return pathname === "/api/kohaku/compose" || pathname === "/api/kohaku/compose/stream";
}

/**
 * Peeks at a routed compose response's body for a generation fallback and, if found, calls `onFallback`.
 * Never throws and never consumes the original `response` (reads a clone) — a malformed or non-JSON body
 * (e.g. an error response, or the SSE stream from /compose/stream, which this does not attempt to parse)
 * is simply not reported, not treated as a problem.
 */
async function notifyGenerationFallback(
  response: Response,
  pathname: string,
  onFallback: (info: { from: string; reason: string }) => void,
): Promise<void> {
  if (!isComposeEndpoint(pathname) || !response.ok) return;
  if (response.headers.get("content-type")?.includes("application/json") !== true) return;
  try {
    const body = (await response.clone().json()) as ComposeResponseBody;
    const fallback = body.spec?.provenance?.fallback;
    if (fallback?.kind === "generation" && fallback.from != null && fallback.reason != null) {
      onFallback({ from: fallback.from, reason: fallback.reason });
    }
  } catch {
    // Not JSON, or shaped unexpectedly — not this function's problem to raise.
  }
}

function joinApiPrefix(base: string): string {
  const withTrailingSlash = base.endsWith("/") ? base : `${base}/`;
  return `${withTrailingSlash}api/`;
}

/**
 * The two path prefixes a same-origin request is matched against, in order:
 * - `/api/` (the site root), unconditionally — this is what sample-web's own API client
 *   (`kohaku/client.ts`) actually calls, as a hardcoded root-absolute path, regardless of any deployed
 *   `<base>`. sample-web is reused unforked (design.md decision 57), so the shim has to meet it here rather
 *   than the other way around.
 * - `<base>api/` — additive, for a base-aware caller (or a future one): under a non-root base (a GitHub
 *   Pages project site, `<base>` = `/kohaku/`), `/kohaku/api/*` is recognized the same way.
 * When `base` is already `/` both prefixes are the same string, which is harmless (checked twice, matches
 * once).
 */
function apiPrefixesFor(base: string): string[] {
  return ["/api/", joinApiPrefix(base)];
}

/**
 * Installs a global `fetch` shim: a same-origin request under `/api/*` or `<base>api/*` (see
 * `apiPrefixesFor`) is routed to `getHost()`'s `app.fetch` (rewritten to the `/api/*` path host-rest's
 * routes are actually mounted at — the host has no concept of the page's `<base>`); everything else — a
 * different origin, or the same origin outside both prefixes — passes straight through to the real network
 * `fetch`, unchanged. No service worker: this only intercepts `fetch()` calls made from the same JS realm
 * that installed it (sample-web's own API client, which is all this playground needs to serve).
 *
 * `getHost` is a callback, not a value, so `reset.ts` can swap in a freshly built host (new storage, new
 * lineage) without reinstalling the shim — every intercepted request reads whatever `getHost()` returns at
 * that moment.
 *
 * Returns a restore function that puts back whatever `fetch` was before (tests use this for isolation;
 * nothing in the playground's own runtime ever needs to uninstall the shim once page-load has installed it).
 */
export function installFetchShim(getHost: () => FetchShimTarget, options: FetchShimOptions = {}): () => void {
  const realFetch = globalThis.fetch.bind(globalThis);
  const origin = options.origin ?? globalThis.location?.origin;
  const prefixes = apiPrefixesFor(options.base ?? import.meta.env.BASE_URL ?? "/");

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // input may be a bare relative string ("/api/health", exactly what sample-web's own client calls with)
    // — resolve it against `origin` before doing anything else, rather than handing it straight to `new
    // Request()`, which (unlike a real browser's own fetch) has no notion of "the current page" to resolve
    // a relative URL against and throws instead.
    const rawUrl = input instanceof Request ? input.url : input.toString();
    const resolvedUrl = new URL(rawUrl, origin);
    const matchedPrefix =
      origin != null && resolvedUrl.origin === origin
        ? prefixes.find((p) => resolvedUrl.pathname.startsWith(p))
        : undefined;

    if (matchedPrefix != null) {
      const request = input instanceof Request ? input : new Request(resolvedUrl, init);
      const rewrittenUrl = new URL(resolvedUrl);
      rewrittenUrl.pathname = `/api/${resolvedUrl.pathname.slice(matchedPrefix.length)}`;
      const response = await getHost().fetch(await rewriteRequest(request, rewrittenUrl));
      if (options.onGenerationFallback != null) {
        void notifyGenerationFallback(response, rewrittenUrl.pathname, options.onGenerationFallback);
      }
      return response;
    }
    return realFetch(input, init);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = realFetch;
  };
}

/**
 * Rebuilds `request` at `newUrl`. The body is read eagerly into an ArrayBuffer (rather than passing
 * `request.body`, a ReadableStream, straight through) so the Fetch spec's `duplex: "half"` requirement for
 * a streamed request body never comes up — every request this playground proxies (compose, events, the
 * governance endpoints) is a small, fully-buffered JSON payload anyway (host-rest's own 1 MiB bodyLimit).
 *
 * `signal` is forwarded unchanged. Without it, the rebuilt Request gets its own never-aborted signal, so a
 * caller's `AbortController.abort()` would silently stop being observable the moment a request crosses this
 * shim — host-rest's routes read `c.req.raw.signal` to cancel an in-flight compose (`composeWithFixation` /
 * `composeStream`, and host-core's cancelled-aware `recordComposedResult`), so losing the signal here would
 * make every one of those cancellation paths unreachable from the browser.
 */
async function rewriteRequest(request: Request, newUrl: URL): Promise<Request> {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(newUrl, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? await request.clone().arrayBuffer() : undefined,
    signal: request.signal,
  });
}
