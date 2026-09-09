/**
 * Low-level transport (fetch dependency injection).
 *
 * Follows the same "make the transport swappable" style as data-binding's `BindingFetcher`. The default is the
 * global Web-standard `fetch` (present in both browsers and Node >= 18). Tests inject the in-memory Hono app's
 * `app.request` to exercise the typed client without a real network.
 *
 * The types use the Web-standard (DOM lib) `RequestInit` / `Response` directly. SSE stream consumption needs to
 * handle `Response.body` (ReadableStream), and these are environment-neutral (common to browser/Node) globals
 * (renderer-react uses the same lib setup).
 */
export type Transport = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Returns the default transport (global fetch). In environments without fetch (Node < 18 etc.), throws a clear
 * error prompting the caller to inject `transport` explicitly.
 */
export function globalTransport(): Transport {
  if (typeof (globalThis as { fetch?: Transport }).fetch !== "function") {
    throw new Error(
      "Global fetch not found. Please specify KohakuClientConfig.transport explicitly (Node < 18, etc.).",
    );
  }
  // Re-reads globalThis.fetch on every call (not captured once at construction time) so that swapping the
  // global implementation later (a test's fetch stub installed after a long-lived client/module was created,
  // a polyfill loading after this module, etc.) is actually observed on the next request.
  return (url, init) => {
    const f = (globalThis as { fetch?: Transport }).fetch;
    if (typeof f !== "function") {
      throw new Error(
        "Global fetch not found. Please specify KohakuClientConfig.transport explicitly (Node < 18, etc.).",
      );
    }
    return f(url, init);
  };
}
