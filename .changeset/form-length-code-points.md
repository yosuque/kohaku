---
"@kohaku-ui/renderer-core": patch
"@kohaku-ui/spec-core": patch
---

Form field `minLength` / `maxLength` now count Unicode code points, matching the ACT-PRM-001 `paramsSchema` check, so a non-BMP character (an emoji) no longer counts twice on the client. `@kohaku-ui/spec-core` exports `codePointLength` for this.
