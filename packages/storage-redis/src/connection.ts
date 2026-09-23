import type { Redis } from "ioredis";

/**
 * The `ready()` connection helpers shared by `redis-storage-port.ts` and `revocation.ts` -- both build a
 * `ready()` gate around a `url`- or `client`-constructed ioredis connection the same way. This logic has
 * already needed two separate fixes on this branch (a `ready()` that permanently cached a rejection;
 * leaked `ready`/`error` listeners), so it lives here once rather than as two copies that a third fix
 * would have to land in twice, with nothing enforcing that both actually got it.
 */

/**
 * `ready()`'s path for a `url`-constructed (owned, `lazyConnect: true`) client: kick off the connection
 * ioredis otherwise wouldn't start on its own. The returned promise is bounded by the `connectTimeout`
 * already passed to the `Redis` constructor.
 */
export function connectOwned(redis: Redis): Promise<void> {
  if (redis.status === "ready") return Promise.resolve();
  return redis.connect();
}

/**
 * `ready()`'s path for an injected client: resolve immediately if already `"ready"`, otherwise wait for the
 * `ready` or `error` event, bounded by `timeoutMs`. Listeners are always removed on whichever path settles
 * first (resolve, reject, or timeout) so repeated calls -- e.g. from `ready()`'s retry-on-failure memo --
 * cannot leak them.
 */
export function waitUntilReady(client: Redis, timeoutMs: number): Promise<void> {
  if (client.status === "ready") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      client.off("ready", onReady);
      client.off("error", onError);
    };
    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: unknown): void => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Redis connection did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);
    client.once("ready", onReady);
    client.once("error", onError);
  });
}
