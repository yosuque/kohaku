---
"@kohaku-ui/spec-core": patch
---

`decodeSeqCursor` now rejects a lineage cursor whose `seq` is fractional, negative or beyond the safe-integer range with `LineageCursorError` (a 400 on the REST routes) instead of surfacing a TypeError or a rewound page. The Python decoder enforces the same bounds.
