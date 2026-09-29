---
"@kohaku-ui/host-core": patch
"@kohaku-ui/spec-core": patch
---

The in-process `RateLimitStore` keeps its stored last-refill time monotonic, so a caller whose clock went backwards no longer makes the next take over-refill the bucket; the `RateLimitStore` contract now says a distributed store must not let clock skew over-refill either. The rate-limit bucket key docs now describe the key accurately (`JSON.stringify` of the triple), and the Python port keeps non-ASCII characters literal in the key so both ports encode it identically (design.md decision 69).
