---
"@kohaku-ui/lineage": patch
"@kohaku-ui/client": patch
"@kohaku-ui/spec-core": patch
"@kohaku-ui/host-rest": patch
"@kohaku-ui/cli": patch
---

Compliance Evidence Pack (design.md decision 67): `verifyEvidencePack` now checks the signature over the raw `manifest.json` value before validating its shape, so a field added, removed or retyped after signing no longer verifies (the manifest schemas are strict and have no defaults, and the Python port matches). `buildEvidencePack` refuses to emit a file larger than the 64 MiB cap that verification enforces (new `maxFileBytes` option), instead of producing a pack that cannot be verified, and reports unparseable lines inside signed jsonl content.

`approvals.jsonl` now also indexes `action.approvalRequested`, `action.approved`, `action.denied` and `policy.applied` events, so its bytes (and its manifest hash) change for any pack whose window contains them.

`kohaku evidence export` now validates and canonicalizes `--since` / `--until` like the REST `/lineage` route (via the new `parseIso8601` export of spec-core, which host-rest now imports): `+hh:mm` offsets are converted to UTC, a date-only `--until` includes that whole UTC day, and an invalid or reversed window exits 2 instead of signing a wrongly scoped pack. The client's `lineagePages` and the pack builder throw instead of looping forever when a host returns the cursor it was given.
