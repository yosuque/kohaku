---
"@kohaku-ui/registry": patch
---

`negotiate` no longer overwrites an existing `generation` fallback (or one without a `kind`) with its own `negotiation` trace. The downgrades are still applied and returned, but a generation-exhausted Spec keeps its deterministic-output marker, so it stays undisclosed as AI-generated content (design.md decision 66).
