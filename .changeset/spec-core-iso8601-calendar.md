---
"@kohaku-ui/spec-core": patch
---

`parseIso8601` now rejects an impossible calendar date or clock time (`2026-02-30`, `T24:00:00Z`) instead of letting `Date.parse` roll it over, so the REST `/lineage` and `/analytics/summary` routes answer 400 for it, matching the CLI and the Python port.
