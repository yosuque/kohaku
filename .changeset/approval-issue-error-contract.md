---
"@kohaku-ui/spec-core": patch
"@kohaku-ui/authz-hmac": patch
"@kohaku-ui/host-rest": patch
---

`POST /approvals` no longer reports every `issueApproval` failure as a 400 with the raw message: only an `ApprovalIssueError` (or an error carrying `code: "APPROVAL_ISSUE_REJECTED"`, both new in spec-core; `createHmacApprovalPort` throws it for a self-approval) maps to 400, and any other error is reported to `onError` and returned as a fixed-text 500 `INTERNAL` (design.md decision 63). `createHmacApprovalPort` also gains `maxTtlSeconds` (default 3600) that clamps every granted lifetime, so a caller-supplied `ttlSeconds` up to 86400 no longer yields a day-long replay window when no `ApprovalStore` is configured.
