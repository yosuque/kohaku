---
"@kohaku-ui/renderer-core": patch
"@kohaku-ui/renderer-react": patch
"@kohaku-ui/renderer-wc": patch
---

Editable `presentSpreadsheet` cells now run the governed-action pre-check in both renderers (a value the `actionManifest` rejects stays in edit mode with `aria-invalid`), and an optimistic cell edit is discarded again when its `cellEdit` invoke ends `invalid`, `awaitingApproval` or `failed`, so the grid shows the server value. renderer-core adds `revertCellEdit`; renderer-react's `useInvokeAction().invoke` takes an optional `onPhase` callback (design.md decisions 62-64).
