---
"@kohaku-ui/storage-redis": minor
---

`createRedisStoragePort` now builds a `url`-constructed client with `lazyConnect: true` and `enableOfflineQueue: false` (new `connectTimeoutMs` / `maxRetriesPerRequest` options), and adds a memoized `ready(): Promise<void>` that every method awaits first. Without this, a command issued while Redis is unreachable used to queue silently and hang the caller indefinitely; now it fails fast with a bounded rejection instead. An injected `client`'s options are never overridden — `ready()` resolves immediately when it is already `"ready"`, otherwise it waits for that client's own `ready` / `error` event bounded by `connectTimeoutMs`.
