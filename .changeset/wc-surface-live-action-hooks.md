---
"@kohaku-ui/renderer-wc": patch
---

`<kohaku-surface>` reads `actionManifest`, `confirm` and `requestApproval` live at invoke time instead of rebuilding the mounted tree when one is reassigned. Assigning a spec and its manifest back to back no longer tears down an L2 sandbox iframe twice, and an inline `confirm` arrow no longer causes a rebuild on every assignment.
