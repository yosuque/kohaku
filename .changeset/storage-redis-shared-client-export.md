---
"@kohaku-ui/storage-redis": minor
---

Exports `createRedisConnection` (+ `CreateRedisConnectionOptions` / `RedisConnectionHandle`) from the package root. A caller that needs `createRedisStoragePort` and `createRedisRevocationStore` to share a single ioredis client (rather than each opening its own) can now build the client once with `createRedisConnection` and inject it into both via their existing `client` option, instead of reaching into the package's internal `./connection.js`.
