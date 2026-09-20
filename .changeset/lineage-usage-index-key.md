---
"@kohaku-ui/lineage": patch
---

Fix the in-memory `(tenant, artifactId)` usage-index key so a tenant id containing a space can no longer collide with another tenant/artifact pair (the key was a space-joined string). The key is never persisted, so nothing on disk changes. The three copies of the "latest `component.generated` per artifact" index now share one helper.
