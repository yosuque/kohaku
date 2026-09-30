---
"@kohaku-ui/renderer-core": patch
---

`deriveDisclosure` no longer treats a capability-negotiation fallback as "not model output": only a `generation` fallback (or one with no `kind`) yields `"none"`, so a model-generated L1/L2 Spec keeps its AI-generation disclosure when negotiation demotes a single part (design.md decision 66, SPEC-DISC-001).
