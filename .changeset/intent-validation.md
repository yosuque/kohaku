---
"@kohaku-ui/spec-core": minor
"@kohaku-ui/host-core": minor
"@kohaku-ui/host-rest": minor
"@kohaku-ui/host-mcp-apps": minor
"@kohaku-ui/semantic-llm": minor
---

Closes a validation gap for a directly-specified Intent (`kind: "intent"`): unlike NL/GUI input, it never
passed through `SemanticPort.normalize` (or any Intent-catalog lookup a `normalize` implementation may
consult internally), so an unknown canonical or an invalid/unknown param reached `finalizeIntent`
unchecked — minting a fresh `intentHash` for a request that could never resolve, and previously surfacing
as a 500 `COMPOSE_FAILED` from deep inside `compose()` instead of a client-caused 422.

`spec-core`'s `SemanticPort` gains an optional `validateIntent?(intent, ctx): Promise<IntentInput>` (new
exports `IntentValidationError` and `IntentValidationIssue`, `errors.ts`): implement it to reject such a
request by throwing `IntentValidationError` (`code: "INTENT_INVALID"`, plus a client-safe `issues` array),
or return the normalized `IntentInput` (e.g. with schema defaults filled in) on success. `host-core`'s
`resolveIntent` calls it, when present, before `finalizeIntent`, for every host entry point that resolves a
directly-specified Intent: REST's `/compose`, `/events` (the pre-event `current`), and
`/fixations/approve`; MCP's compose-family tools and `kohaku_event`'s `current`. Rejected requests write
nothing to the cache, lineage, or fixation store. `@kohaku-ui/semantic-llm`'s `createLlmSemanticPort`
implements it by default (backed by a new, optional `IntentCatalogLike.validateParams`), so a product using
the default SemanticPort gets this for free; a `SemanticPort` that omits `validateIntent` keeps the
historical unchecked-finalize behavior (backward compatible), and `compose()` called directly from the
library (bypassing a host entirely) is unvalidated by design — see `docs/design.md` decision #51.

**Hash-changing behavior, by design**: an already fully-specified directly-specified Intent (every param
given explicitly, including ones that have a schema default) hashes exactly as it always did. An Intent
that relied on a catalog's schema default (the param omitted) previously hashed with that field missing;
after this change, `validateIntent`'s normalized return value — with the default filled in — is what gets
hashed and finalized instead. A pre-existing fixation keyed on the old (default-omitted) `intentHash` will
no longer be reached by that same request; re-approving the fixation under the new hash restores it. This
also changes an incidental status code: composing a promoted Intent after it has been withdrawn (no longer
in the catalog) now correctly returns 422 `INTENT_INVALID` instead of 500 `COMPOSE_FAILED`, since
`validateIntent` catches the now-unknown canonical before `compose()` ever runs.

SPEC.md §6.1 gains **REST-INT-002** (SHOULD): a host whose `SemanticPort` implements `validateIntent`
should reject an unknown canonical / invalid params with 422 `INTENT_INVALID`, leaving no trace in the
cache, lineage, or fixation store.
