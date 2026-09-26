---
"@kohaku-ui/spec-core": patch
"@kohaku-ui/host-rest": patch
"@kohaku-ui/host-mcp-apps": patch
---

Hardens JSON input validation against pathologically deep nesting. `JsonObjectSchema` and `JsonValueSchema`
(`spec-core`) now reject an over-deep value up front, before parsing its structure, rather than only
checking depth afterward. `host-rest` additionally checks a request body's whole nesting depth immediately
after `JSON.parse`, ahead of any zod schema. `host-mcp-apps`' tool inputs (`kohaku_action`, `kohaku_event`,
and the compose family) already declare these same `spec-core` schemas for their JSON-object fields, so
they are covered by the same fix without any code change of their own.

The existing depth limit (32) is unchanged, and every input that was accepted or rejected before continues
to be — this only changes how an over-deep input is rejected (a validation error, rather than a resource
exhaustion of the parsing recursion).
