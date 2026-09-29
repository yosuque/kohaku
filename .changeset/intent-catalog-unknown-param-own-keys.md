---
"@kohaku-ui/semantic-llm": patch
---

`IntentCatalog.validateParams` now reports a param named after an `Object.prototype` member (`constructor`, `toString`, `__proto__`, ...) as an unknown param instead of letting Zod silently strip it.
