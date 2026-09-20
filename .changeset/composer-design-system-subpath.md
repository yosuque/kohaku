---
"@kohaku-ui/composer": patch
---

Expose `design-system.ts` (DEFAULT_KIT_VOCABULARY and friends) under a new `@kohaku-ui/composer/design-system` subpath, mirroring the existing `./l2-api` pattern, so node-independent downstream packages (e.g. sandbox, which sets `"types": []`) can import the design-kit vocabulary without pulling composer's full barrel — and with it `@kohaku-ui/llm`'s `process.env` usage — into their typecheck.
