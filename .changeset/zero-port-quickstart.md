---
"@kohaku-ui/semantic-llm": minor
"@kohaku-ui/cli": minor
---

Zero-Port quickstart: `kohaku init --from <data.csv|.json|.sqlite>` generates a runnable app (DomainPort, Intent catalog, L0 fixed Spec, Dashboard + Chat, golden test) that depends only on the published packages. New package `@kohaku-ui/semantic-llm` provides the default SemanticPort (`createLlmSemanticPort`) and a generic Intent catalog; the sample API now builds on it.
