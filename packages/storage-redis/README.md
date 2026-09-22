# @kohaku-ui/storage-redis

A Redis-backed `StoragePort` for kohaku (Spec cache, lineage, promotion state, fixation) — a reference production adapter; the contract stays `@kohaku-ui/spec-core`'s `ports.ts`.

```ts
import { createRedisStoragePort } from "@kohaku-ui/storage-redis";

const storage = createRedisStoragePort({ url: "redis://localhost:6379" });
await storage.putSpecCache("some-cache-key", spec);
const cached = await storage.getSpecCache("some-cache-key");
await storage.close();
```

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

This package (Task 2 of the production-adapters plan) implements the Spec-cache half of `StoragePort` (`getSpecCache` / `putSpecCache` / `close`); lineage, promotion and fixation are implemented in later work and currently throw `Error("not implemented")`.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md).

The packages in this scope share a single version and are designed to be installed together.

- Documentation: https://github.com/yosuque/kohaku#readme
- Source: https://github.com/yosuque/kohaku/tree/main/packages/storage-redis

Licensed under the Apache License, Version 2.0.
