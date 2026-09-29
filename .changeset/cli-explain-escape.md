---
"@kohaku-ui/cli": patch
---

`kohaku explain` escapes control characters (other than newlines) in the lineage-derived strings it prints, so a tampered lineage record cannot inject terminal escape sequences.
