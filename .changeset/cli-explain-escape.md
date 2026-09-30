---
"@kohaku-ui/cli": patch
---

`kohaku explain` escapes control characters (newlines included) in the lineage-derived strings it prints, so a tampered lineage record can neither inject terminal escape sequences nor forge an extra report line.
