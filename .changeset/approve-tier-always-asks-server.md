---
"@kohaku-ui/renderer-core": patch
---

An `"approve"`-tier action with no `requestApproval` hook (or a hook that returns no token) is now sent to the server without an `approval` token instead of being short-circuited locally. The server records `action.approvalRequested` and answers `403 APPROVAL_REQUIRED`, and the renderer reports that response's approval descriptor (`requestId` / `payloadHash`) in the `awaitingApproval` phase, so an approver has a pending record to act on (design.md decision 63).
