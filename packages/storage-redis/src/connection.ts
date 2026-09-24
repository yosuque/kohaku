import { Redis } from "ioredis";

/**
 * The connection lifecycle shared by `redis-storage-port.ts` and `revocation.ts` -- both build an
 * ioredis client (`url`-constructed or injected) and gate every command behind a `ready()` promise the
 * same way. This logic has already needed several separate fixes on this branch (a `ready()` that
 * permanently cached a rejection; leaked `ready`/`error` listeners; no `error` listener at all, which
 * ioredis surfaces as an unhandled `error` event -- a process crash by Node's own EventEmitter contract;
 * no `commandTimeout`, which lets a half-open socket hang a command forever instead of failing it), so
 * it lives here once rather than as two copies that a third fix would have to land in twice, with
 * nothing enforcing that both actually got it.
 */

/** `connectTimeoutMs`'s default: passed to ioredis as `connectTimeout`, bounding the initial connection
 * attempt of an owned (`url`-constructed) client so a network partition fails fast instead of hanging. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

/** `commandTimeoutMs`'s default: passed to ioredis as `commandTimeout`, bounding every individual command
 * an owned client issues. Without it, a half-open socket (the TCP connection looks alive but the peer
 * never responds -- a firewall drop, a killed-but-not-reset server process) leaves a command pending
 * forever instead of failing it; `connectTimeout` alone does not cover this, since the connection was
 * already established when the command was sent. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 5000;

/** `maxRetriesPerRequest`'s default: ioredis's own default (`20`) is that many reconnect-and-retry
 * cycles for a single queued command, which can take a long time to give up; `3` fails a command sooner
 * while still tolerating a brief reconnect. */
export const DEFAULT_MAX_RETRIES_PER_REQUEST = 3;

export interface CreateRedisConnectionOptions {
  /** ioredis connection URL (`redis://…` / `rediss://…`). Mutually exclusive with `client`. */
  url?: string;
  /** An existing ioredis client to share. `close()` then leaves it connected (the owner disconnects it),
   * and no `error` listener is attached to it -- attach your own (an unhandled `error` on an ioredis
   * client is a process crash by Node's EventEmitter contract). */
  client?: Redis;
  /** Connection-establishment timeout in milliseconds for an owned (`url`-constructed) client. Passed to
   * ioredis as `connectTimeout`. Default `DEFAULT_CONNECT_TIMEOUT_MS`. Also bounds how long `ready()`
   * waits for an injected `client` to reach `"ready"`. Ignored (for construction) for an injected
   * `client` -- its own options are never overridden. */
  connectTimeoutMs?: number;
  /** Per-command timeout in milliseconds for an owned client. Passed to ioredis as `commandTimeout`.
   * Default `DEFAULT_COMMAND_TIMEOUT_MS`. Ignored for an injected `client`. */
  commandTimeoutMs?: number;
  /** ioredis's own `maxRetriesPerRequest` for an owned client. Default `DEFAULT_MAX_RETRIES_PER_REQUEST`.
   * Ignored for an injected `client`. */
  maxRetriesPerRequest?: number;
  /** Called when an owned client emits an `error` event (a connection drop, a command timeout, a DNS
   * failure). Without a listener, ioredis re-throws it as an unhandled `error` event, which crashes the
   * process by Node's own EventEmitter contract. Defaults to logging via `console.error`. Never invoked
   * for an injected `client` (attach your own listener to it instead). */
  onError?: (error: Error) => void;
}

/**
 * The `ready()` / `close()` lifecycle handle returned by `createRedisConnection`. Both
 * `createRedisStoragePort` and `createRedisRevocationStore` build their own keys and commands against
 * `.redis` and delegate connection management to this.
 */
export interface RedisConnectionHandle {
  /** The client to issue commands against (owned or injected). */
  redis: Redis;
  /** Whether this handle created `redis` itself (as opposed to reusing an injected `client`). */
  owned: boolean;
  /**
   * Resolves once the client is connected and ready to accept commands; rejects if it can't within
   * `connectTimeoutMs`. Memoized, but a failed attempt clears the memo so a transient outage (Redis
   * briefly unreachable, a restart mid-deploy) doesn't permanently strand this handle with no retry
   * path -- the next call retries from scratch instead of replaying a cached rejection forever.
   *
   * For an owned (`url`-constructed, `lazyConnect: true`) client, this calls ioredis's own `connect()`,
   * bounded by the `connectTimeout` passed at construction. For an injected `client`, this never calls
   * `connect()` itself (the caller owns that client's lifecycle): it resolves immediately if already
   * `"ready"`, otherwise waits for the client's `ready` or `error` event, bounded by `connectTimeoutMs`
   * -- removing its listeners on whichever path settles first, so repeated calls (e.g. via the
   * retry-on-failure memo) cannot leak them.
   */
  ready(): Promise<void>;
  /** Ends `redis` if (and only if) this handle created it: a graceful `quit()` first, falling back to
   * the non-command `disconnect()` if that rejects (e.g. the client never connected --
   * `enableOfflineQueue: false` means `quit()` itself rejects rather than queuing). `disconnect()` also
   * cancels ioredis's own pending reconnect timer, so a handle that failed to connect can still be
   * closed cleanly instead of leaving a background reconnect loop running. */
  close(): Promise<void>;
}

/**
 * Builds (or adopts) an ioredis client and its `ready()` / `close()` lifecycle. `label` identifies the
 * caller in validation and "not ready" error messages (e.g. "redis storage port", "redis revocation
 * store").
 *
 * Fail-fast: an owned client is built with `lazyConnect: true`, `enableOfflineQueue: false`,
 * `connectTimeout: connectTimeoutMs`, and `commandTimeout: commandTimeoutMs`. Without those, a command
 * issued while Redis is unreachable would queue silently (ioredis's default offline queue) and hang the
 * caller, and a command sent over a half-open socket would hang rather than time out -- this stack has
 * no request-level timeout of its own. This is not applied to an injected `client`: overriding options
 * the caller chose for their own shared client is not this helper's call.
 */
export function createRedisConnection(
  options: CreateRedisConnectionOptions,
  label: string,
): RedisConnectionHandle {
  if (options.client != null && options.url != null) {
    throw new Error(`${label}: pass either \`url\` or \`client\`, not both`);
  }
  if (options.client == null && options.url == null) {
    throw new Error(`${label}: one of \`url\` or \`client\` is required`);
  }

  const owned = options.client == null;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  let redis: Redis;
  if (options.client != null) {
    redis = options.client;
  } else {
    redis = new Redis(options.url!, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: options.maxRetriesPerRequest ?? DEFAULT_MAX_RETRIES_PER_REQUEST,
      connectTimeout: connectTimeoutMs,
      commandTimeout: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    });
    redis.on("error", (error: Error) => {
      if (options.onError != null) options.onError(error);
      else console.error(`[@kohaku-ui/storage-redis] ${label}: Redis connection error:`, error);
    });
  }

  let readyPromise: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    if (readyPromise == null) {
      const attempt = owned ? connectOwned(redis) : waitUntilReady(redis, connectTimeoutMs);
      readyPromise = attempt.catch((error: unknown) => {
        // Don't memoize a failed connection attempt -- see this handle's `ready()` doc comment.
        readyPromise = undefined;
        throw error instanceof Error
          ? new Error(`${label} is not ready: ${error.message}`, { cause: error })
          : error;
      });
    }
    return readyPromise;
  };

  return {
    redis,
    owned,
    ready,
    async close() {
      if (!owned) return;
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    },
  };
}

/**
 * `ready()`'s path for an owned (`url`-constructed, `lazyConnect: true`) client: kick off the connection
 * ioredis otherwise wouldn't start on its own. The returned promise is bounded by the `connectTimeout`
 * already passed to the `Redis` constructor.
 */
function connectOwned(redis: Redis): Promise<void> {
  if (redis.status === "ready") return Promise.resolve();
  return redis.connect();
}

/**
 * `ready()`'s path for an injected client: resolve immediately if already `"ready"`, otherwise wait for
 * the `ready` or `error` event, bounded by `timeoutMs`. Listeners are always removed on whichever path
 * settles first (resolve, reject, or timeout) so repeated calls -- e.g. from `ready()`'s retry-on-failure
 * memo -- cannot leak them.
 */
function waitUntilReady(client: Redis, timeoutMs: number): Promise<void> {
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
