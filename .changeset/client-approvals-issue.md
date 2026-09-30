---
"@kohaku-ui/client": patch
---

`KohakuClient` gains `approvals.issue({ action, payloadHash, requesterId, ttlSeconds? })`, a typed wrapper over `POST /approvals` (SPEC ACT-APR-001) that returns `{ approval }`; new exports `ApprovalsClient`, `ApprovalIssueRequest` and `ApprovalIssueResult`. A type-level test now pins the client's `ExplainDecision*` types as assignable from lineage's view.composed decision summary.
