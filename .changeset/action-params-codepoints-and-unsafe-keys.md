---
"@kohaku-ui/spec-core": patch
"@kohaku-ui/host-core": patch
---

Governed-action payload validation now counts `minLength` / `maxLength` in Unicode code points (matching the Python port; a non-BMP character such as an emoji no longer counts twice), and the `ActionGate` rejects a `__proto__` / `constructor` / `prototype` key anywhere in the payload (objects and arrays, any depth) with an `unsafeKey` issue even when the action declares no `paramsSchema`, an undeclared property carries it, or an array has no `items` (design.md decision 62; SPEC ACT-PRM-001). New export: `findUnsafeActionParamKeys`.
