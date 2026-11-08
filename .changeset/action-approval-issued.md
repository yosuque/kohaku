---
"@kohaku-ui/lineage": minor
"@kohaku-ui/host-core": minor
"@kohaku-ui/host-rest": minor
"@kohaku-ui/admin-react": minor
---

A successful `POST /approvals` now records an `action.approvalIssued` lineage event (SPEC LIN-ACT-001, design.md #72), so an auditor can see that an approval was minted and an approver's inbox can tell "issued, not yet used" from "not yet approved".

- The event's **actor is the approver** (the one `action.*` event whose actor is not the requester). Its payload is `{ action, payloadHash, requesterId, approverId, ttlSeconds, expiresAt }`; it carries no token id (`jti`) or anything the token could be rebuilt from. `expiresAt` is computed by the host as issue time + `ttlSeconds` (the `ApprovalPort` does not report its own expiry), so it is advisory: it differs from the real expiry when the port's own default TTL differs from `DEFAULT_APPROVAL_TTL_SECONDS` or when the port clamps the lifetime.
- Recording is fail-open and happens only after issuance succeeded; a recorder failure is reported to `onError` (`approvals.audit`) and the response stays 200. `ActionAuditRecorder.approvalIssued` (and lineage's `RestActionAuditRecorder.approvalIssued`) is **optional**, so a custom recorder keeps working unchanged; `createActionAuditRecorder` (lineage) implements it. MCP is unchanged (it has no issuance tool).
- **Evidence packs**: `action.approvalIssued` is now listed in `approvals.jsonl`, so the `approvals` count and `manifest` hash of a pack built over a window that contains one differ from before.
- `@kohaku-ui/admin-react`: the Approvals tab reads the new event (`PendingApproval.issued`) and shows "Issued by … — expires in …" with Approve disabled while the token is valid. Settlement is still decided by `action.approved` alone; an expired issuance is ignored. `derivePendingApprovals` takes an optional `{ now }`. New `AdminMessages.approvals.issuedBy` (a custom `AdminMessages` object must add it); `approveDisabledIssued` is reworded because the token may have been issued by another approver or before a reload.
- Python port (`kohaku-ui` on PyPI): the same event, recorder method, evidence inclusion and `POST /approvals` recording.
