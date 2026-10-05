---
"@kohaku-ui/registry": patch
---

The core `action.button` description (the text shown to the model and published in the catalog) now says that a write Action's name travels in the `action` key of the event payload, and that the component has no `action` prop (`presentForm` uses `props.action`). The props schema and the catalog fingerprint are unchanged.
