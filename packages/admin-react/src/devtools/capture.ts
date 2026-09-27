import type { KohakuClientConfig } from "@kohaku-ui/client";

/** One captured response, as reported by KohakuClientConfig.onResponse. */
export interface RecentRequest {
  path: string;
  status: number;
  requestId?: string;
  /** Date.now() at capture time (client-side clock; not the server's own timestamp). */
  at: number;
}

/** Read/subscribe accessor for the requests withDevToolsCapture has captured so far. Shaped for React's
 * useSyncExternalStore (KohakuDevTools's own consumption pattern), but usable standalone too. */
export interface DevToolsCapture {
  /** The captured requests, newest first, capped at the configured maxEntries. */
  getRecentRequests(): RecentRequest[];
  /** Registers a listener called after every new capture; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

const DEFAULT_MAX_ENTRIES = 20;

/**
 * Wraps a KohakuClientConfig's onResponse hook so KohakuDevTools can passively collect recent requestIds
 * without the embedding product wiring capture by hand at every call site. Pass the returned `config` to
 * `createKohakuClient` (it calls the original `config.onResponse`, if any, before recording) and the
 * returned `capture` to `KohakuDevTools`'s `capture` prop.
 *
 * A response with no `requestId` (a non-conformant host, or a transport test double that does not set
 * `X-Request-Id`) is still recorded -- there is simply nothing to explain for that entry, which the
 * DevTools UI reflects by disabling that row's "explain" action rather than hiding the entry.
 */
export function withDevToolsCapture(
  config: KohakuClientConfig,
  opts: { maxEntries?: number } = {},
): { config: KohakuClientConfig; capture: DevToolsCapture } {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  let entries: RecentRequest[] = [];
  const listeners = new Set<() => void>();

  const onResponse: NonNullable<KohakuClientConfig["onResponse"]> = (info) => {
    config.onResponse?.(info);
    entries = [{ ...info, at: Date.now() }, ...entries].slice(0, maxEntries);
    for (const listener of listeners) listener();
  };

  return {
    config: { ...config, onResponse },
    capture: {
      getRecentRequests: () => entries,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
}
