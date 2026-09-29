---
"@kohaku-ui/host-core": patch
---

`createConsoleErrorReporter`'s compose lines now carry the correlation id, tier and intent (`[kohaku] compose fallback (correlation req-42, tier L1, intent sales.overview): ...`), so a degradation line can be traced back to its request.
