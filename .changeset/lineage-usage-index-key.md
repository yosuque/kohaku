---
"@kohaku-ui/lineage": patch
---

Fix the in-memory `(tenant, artifactId)` usage-index key: it previously joined the two values with a single delimiter character (a NUL byte in TypeScript, a Unit Separator in Python), which is not collision-free by construction for a tenant or artifact id that could itself contain that character. It now uses a JSON array encoding, which is collision-free for any input. The key is never persisted, so nothing on disk changes. The three copies of the "latest `component.generated` per artifact" index now share one helper.
