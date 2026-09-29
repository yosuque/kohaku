---
"@kohaku-ui/storage-redis": patch
---

Support `ioredis` 6 alongside 5. The peer dependency range is now `^5.11.1 || ^6.0.0`, so a host on `ioredis` 5 installs this release without an `ERESOLVE`. The adapter's behavior is unchanged on both: the one code change is that the `ZRANGE` stop index is passed as the string `"-1"`, which the ioredis 6 typings require and ioredis 5 sends identically on the wire. The package is developed and tested against ioredis 6.
