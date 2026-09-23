# @kohaku-ui/storage-redis

A Redis-backed `StoragePort` for kohaku (Spec cache, lineage, promotion state, fixation) — a reference production adapter; the contract stays `@kohaku-ui/spec-core`'s `ports.ts`.

```ts
import { createRedisStoragePort } from "@kohaku-ui/storage-redis";

const storage = createRedisStoragePort({ url: "redis://localhost:6379" });
await storage.putSpecCache("some-cache-key", spec);
const cached = await storage.getSpecCache("some-cache-key");
await storage.close();
```

## Fail-fast, not hang

A `url`-constructed client is built with `lazyConnect: true` and `enableOfflineQueue: false`. Without those, a command issued while Redis is unreachable would queue silently (ioredis's default offline queue) and the caller would hang until some timeout elsewhere fires — this stack has no request-level timeout of its own. Every method on this port therefore awaits `ready()` first, which turns "unreachable" into a bounded rejection:

```ts
const storage = createRedisStoragePort({ url: "redis://localhost:6379", connectTimeoutMs: 2000 });
await storage.ready(); // rejects within connectTimeoutMs (default 5000ms) instead of hanging
```

`ready()` is memoized, but a failed attempt clears the memo (mirroring `@kohaku-ui/storage-postgres`'s `ready()`) so a transient outage doesn't permanently strand the port — the next call retries from scratch. `RedisStoragePortOptions.connectTimeoutMs` (default 5000) and `.maxRetriesPerRequest` (default 3) tune this for a `url`-constructed client. If you construct a port, see `ready()` reject, and are not going to retry, call `close()` anyway: for a `url`-constructed client, ioredis keeps retrying to connect in the background on its own schedule even after `ready()` has given up, and `close()` is what stops that background reconnect loop.

**Injected `client`**: this port never overrides the options of a `client` you pass in — that client's lifecycle is yours. For the same fail-fast behavior, construct it yourself with `enableOfflineQueue: false` (and typically `lazyConnect: true`); otherwise a command issued before it connects will queue and hang exactly as described above. With an injected client, `ready()` resolves immediately if `client.status === "ready"`, otherwise it waits for that client's own `ready` / `error` event, bounded by `connectTimeoutMs`.

## Key layout

Every key starts with a configurable prefix (default `kohaku`, see `keyPrefix`) so several kohaku hosts can share one Redis database. Tenant-scoped kinds key by `tenantSegment(tenant)`, which is `%` for a missing/empty tenant (a real tenant can never collide with it: `tenantSegment("%")` is percent-encoded to `%25`).

| kind | key | value | notes |
|---|---|---|---|
| Spec cache | `{p}:spec:{cacheKey}` | JSON(UISpec) | `SET … EX ttl` when a ttl is given. Tenant-independent (cache keys are tenant-neutral by invariant). |
| Lineage events | `{p}:lineage:events` (HASH) | field=id, value=JSON | |
| Lineage order | `{p}:lineage:by-seq` (ZSET) | score=seq (`INCR {p}:lineage:seq`), member=id | append order = the contractual order |
| Lineage index | `{p}:lineage:idx:{field}:{value}` (ZSET) | same as above | field ∈ type / tenant / intentHash / artifactId / specHash (read from the payload) |
| Promotion | `{p}:{tseg}:promotion:{artifactId}` | JSON(PromotionState) | tseg = `tenantSegment(state.tenant)` |
| Promotion index | `{p}:{tseg}:promotion:index` and `{p}:promotion:index` (ZSET, `ZADD NX`) | score=seq, member=full key | former = list(tenant), latter = list(undefined) = all |
| Fixation | `{p}:{tseg}:fixation:{intentHash}` | JSON(FixationRecord) | `ifPresent` uses `SET … XX` |
| Fixation index | `{p}:{tseg}:fixation:index` and `{p}:fixation:index` | same as above | delete is `DEL` plus `ZREM` from both indexes |

This package implements the whole of `StoragePort`: the Spec cache (`getSpecCache` / `putSpecCache`, with an optional TTL), lineage (`appendLineage` / `listLineage`), promotion state (`getPromotionState` / `putPromotionState` / `putPromotionStates` / `listPromotionStates`), and fixation (`getFixation` / `putFixation`, including `ifPresent` / `listFixations` / `deleteFixation`) — all tenant-scoped as described above — plus `ready()` and `close()` (see "Fail-fast, not hang" below). `close()` on an owned client tries a graceful `quit()` first and falls back to `disconnect()` if that rejects (e.g. the client never connected — `enableOfflineQueue: false` means `quit()` itself rejects rather than queuing), so a port that failed to connect can still be closed cleanly.

**Known limitation**: `listLineage` narrows the candidate set with a single sorted-set index and applies the remaining predicates client-side, deliberately not using `ZINTER` — a filter whose most selective index is still large (e.g. `type: ["view.composed"]` on a busy host) therefore reads every candidate, and there is no cap or rotation on the event log, the same limitation the reference file port has.

## Capability revocation

`createRedisRevocationStore({ url | client, keyPrefix, connectTimeoutMs, maxRetriesPerRequest })` is a Redis-backed `CapabilityRevocationStore` (`@kohaku-ui/spec-core`'s `ports.ts`) — pass it as `revocations` to `@kohaku-ui/authz-hmac`'s `createHmacAuthzPort` or `@kohaku-ui/authz-jwt`'s `createJwtAuthzPort` so revocation is shared across every instance behind a load balancer, instead of the default in-memory store's per-process deny list.

```ts
import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { createRedisRevocationStore } from "@kohaku-ui/storage-redis";

const revocations = createRedisRevocationStore({ url: "redis://localhost:6379" });
const authz = createHmacAuthzPort(secret, { revocations });

const token = await authz.issueCapability(principal, scopes);
await authz.revokeCapability(token); // signature verified first; a tampered or foreign token is rejected
await authz.verify(token, req); // { ok: false, reason: "capability revoked" }
```

A revoked `jti` is stored as `{prefix}:revoked:{jti}` with `SET … EX` set to the token's own remaining lifetime (`exp - now`), so Redis drops the key itself once the token would have expired anyway — no separate sweep needed. `revoke()` is a no-op when that remaining lifetime is already zero or negative (the token can no longer verify regardless). `isRevoked` is a plain `EXISTS` check. Same fail-fast construction and memoized-and-discarded-on-failure `ready()` as `createRedisStoragePort` above (every method awaits it first) — see "Fail-fast, not hang".

Note that `createRedisRevocationStore` opens its own client, separate from any `createRedisStoragePort` client pointed at the same Redis — the two are never implicitly shared, so pointing both at one deployment means sizing for two connections, not one (pass the same `client` to both if you want a single shared connection instead).

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md).

The packages in this scope share a single version and are designed to be installed together.

- Documentation: https://github.com/yosuque/kohaku#readme
- Source: https://github.com/yosuque/kohaku/tree/main/packages/storage-redis

Licensed under the Apache License, Version 2.0.
