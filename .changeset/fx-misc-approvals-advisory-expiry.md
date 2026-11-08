---
"@kohaku-ui/admin-react": patch
"@kohaku-ui/host-rest": patch
"@kohaku-ui/lineage": patch
---

The Approvals tab no longer disables Approve because of a *recorded* issuance. `action.approvalIssued.expiresAt` is the requested TTL, which the approval port may clamp (the HMAC port caps it at 3600 s), so it could lock re-issue for hours after the token had died. A recorded issuance is now shown as information only ("Issued by … — recorded expiry in … (advisory; the real expiry may be earlier)"); Approve is still disabled for a token minted in the current page session. `AdminMessages.approvals.issuedBy` is reworded (same signature) and `approveDisabledIssued` now describes the page-session case only; sample-web's Japanese messages follow. `POST /approvals` and the `action.approvalIssued` docs state that `expiresAt` is the requested TTL and may exceed the real lifetime. No wire or schema change.
