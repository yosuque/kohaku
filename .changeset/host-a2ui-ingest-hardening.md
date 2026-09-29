---
"@kohaku-ui/host-a2ui": patch
---

`createA2uiIngest` is now atomic per `ingest()` call (an over-limit or failing batch leaves the surface untouched and no longer wedges it), folds a batch with one component copy instead of one per message, caps a message's `components` array and the number of tracked surfaces (`maxSurfaces`), and measures `maxDataModelSizeBytes` in UTF-8 bytes. Surface state, `latest()` and `fixate()` are now keyed by tenant as well as `surfaceId`. A fixated ingest is served and recorded as tier L0, `fixate()` refuses a Spec carrying `provenance.fallback`, and a snapshotted `{path}` binding no longer marks the Spec as a fallback.
