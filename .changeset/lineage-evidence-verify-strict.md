---
"@kohaku-ui/lineage": patch
---

Evidence pack verification now fails (instead of throwing) on a manifest.json holding a number that parses to a non-finite value such as `1e400`, and rejects a manifest.json that contains a duplicate object key at any depth, so the signed parsed value cannot differ between parsers (design.md decision 67).
