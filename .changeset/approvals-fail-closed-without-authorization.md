---
"@kohaku-ui/host-rest": patch
---

`POST /approvals` now fails closed with 501 `NOT_IMPLEMENTED` when `authorizeGovernance` is not wired, instead of letting any authenticated principal other than the requester issue approvals (SPEC ACT-APR-001 clause (e), design.md decision 63). A host that wires `approvals` must also wire `authorizeGovernance` to authorize the `action.approve` operation; the other governance routes keep their allow-when-unwired behavior.
