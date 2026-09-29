---
"@kohaku-ui/storage-redis": patch
---

Move to `ioredis` 6. The peer dependency range is now `^6.0.0` (the catalog's single pinned version), so a host that still uses `ioredis` 5 must upgrade it alongside this release. The adapter's own behavior is unchanged; the one code change is that the `ZRANGE` stop index is passed as the string `"-1"`, which the ioredis 6 typings require.
