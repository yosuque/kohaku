---
"@kohaku-ui/host-rest": patch
---

`POST /approvals` now parses the request body before authorizing and passes the action being approved to `authorizeGovernance` as `operation.action`, so a hook can scope approvers per action (SPEC ACT-APR-001). `governancePolicyFromRoles` accepts `{ tenantOf }` and forwards it to `createGovernancePolicy`, so per-tenant role grants can be bound to the principal's own tenant.
