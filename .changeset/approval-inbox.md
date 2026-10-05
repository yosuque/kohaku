---
"@kohaku-ui/admin-react": patch
"@kohaku-ui/renderer-core": patch
"@kohaku-ui/renderer-react": patch
---

Approvals get an approver-facing inbox and a default requester-side step, with no wire, SPEC or lineage-event change (design.md decision 72). `@kohaku-ui/admin-react` adds an **Approvals** tab (`ApprovalsTab`, `useApprovalInbox`, `derivePendingApprovals`): it derives the pending `"approve"`-tier requests from the lineage tail (`action.approvalRequested` minus later `action.approved` / `action.invoked`) and mints a copyable bearer token with `POST /approvals`; `AdminMessages` gains `tabApprovals` and an `approvals` block (a custom dictionary must add them). `@kohaku-ui/renderer-react` now defaults `requestApproval` to a `globalThis.prompt` for the token, asked only once the node is already awaiting approval (a cancelled or unavailable prompt sends the request tokenless as before). `@kohaku-ui/renderer-core` adds `RendererMessages.actionApprovalPrompt` / `actionAwaitingApprovalDetail` (a custom full `RendererMessages` object must add them) and the awaiting-approval notice now names the request id and payload hash.
