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
}

function joinApiPrefix(base: string): string {
  const withTrailingSlash = base.endsWith("/") ? base : `${base}/`;
  return `${withTrailingSlash}api/`;
}

/**
 * Installs a global `fetch` shim: a same-origin request under `<base>api/*` is routed to `getHost()`'s
 * `app.fetch` (rewritten to the `/api/*` path host-rest's routes are actually mounted at — the host has no
 * concept of the page's `<base>`); everything else — a different origin, or the same origin outside
 * `<base>api/*` — passes straight through to the real network `fetch`, unchanged. No service worker: this
 * only intercepts `fetch()` calls made from the same JS realm that installed it (sample-web's own API
 * client, which is all this playground needs to serve).
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
  const prefix = joinApiPrefix(options.base ?? import.meta.env.BASE_URL ?? "/");

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if (origin != null && url.origin === origin && url.pathname.startsWith(prefix)) {
      const rewrittenUrl = new URL(request.url);
      rewrittenUrl.pathname = `/api/${url.pathname.slice(prefix.length)}`;
      return getHost().fetch(await rewriteRequest(request, rewrittenUrl));
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
 */
async function rewriteRequest(request: Request, newUrl: URL): Promise<Request> {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(newUrl, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? await request.clone().arrayBuffer() : undefined,
  });
}
