---
"@kohaku-ui/authz-hmac": patch
---

`createMemoryApprovalStore` sweeps expired entries at most once per second instead of scanning the whole map on every `consume`; an expired but unswept entry still does not count as consumed, so expiry semantics are unchanged.
