---
"@kohaku-ui/renderer-core": patch
"@kohaku-ui/renderer-react": patch
"@kohaku-ui/renderer-wc": patch
---

Implement `presentSpreadsheet`'s already-declared `sortChange` and `cellEdit` events and `editable` prop in both renderers: a user sort toggle can now emit `sortChange` (`{ value: { field, dir } }`), and `editable: true` turns idle cells into edit-trigger buttons that swap to a text input, coercing the typed value by column type and delivering a changed, valid edit via `cellEdit` (`{ row, value: { column, value, previousValue, rowIndex } }`) over the invoke path — with an optimistic local display that a fresh fetch discards automatically. Also cap `presentSpreadsheet`'s local (non-serverSide) row rendering at 500 rows and make the truncation footer honest when the source reports no `total`.
