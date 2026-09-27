---
"@kohaku-ui/host-rest": minor
---

Replace `node:crypto`'s `randomUUID` with `globalThis.crypto.randomUUID()` in the request-id and
self-heal-error fallback paths (`routes/compose.ts`, `routes/shared.ts`). Both are the exact same
RFC 4122 v4 UUID generator — Node >= 19 and every evergreen browser expose it as `globalThis.crypto`
— so this removes host-rest's only Node-only import with no behavior change, in support of running a
host-rest-based host (e.g. the static playground, `@kohaku-ui-sample/playground`) entirely in a browser.
