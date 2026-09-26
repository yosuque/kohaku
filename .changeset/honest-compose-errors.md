---
"@kohaku-ui/composer": patch
"@kohaku-ui/semantic-llm": patch
"@kohaku-ui/host-core": patch
"@kohaku-ui/cli": patch
---

Makes a fallback's reason and an `onError` observation honest about *why* generation degraded, instead of
collapsing every non-happy-path into the same wording.

`composer`'s L1 tier ladder previously returned the identical "L1 constrained generation failed
catalog/structure validation" reason whether the LLM provider was actually unreachable (a transient
error) or the model answered but its output failed validation. A transient failure now gets its own
reason naming the provider (with the underlying `LlmError` code in parentheses when known, e.g. "(provider
error)") and pointing at `KOHAKU_LLM_PROVIDER`/the provider API key; the validation-failure wording is
unchanged. New `ComposeErrorContext.failure` and `TierResult.lastError` let `observer.onError` receive the
classified failure kind and the underlying error (previously always `undefined` for a fallback) without
string-matching `reason`.

`refs.ts`'s `SEMANTIC_FAILED` wrapping now appends a `resolveQuery` failure's own message when the cause is
a "typed" error (a string `code` property — the existing convention for a client-safe message), so e.g. an
unknown Intent name reaches the caller instead of the generic "query resolution failed" alone; an untyped
cause is left exactly as before. `semantic-llm`'s `resolveQuery` now throws a typed `UnknownIntentError`
(exported) instead of a plain `Error`, so its own unknown-intent failures benefit from this.

New `host-core` `formatErrorChain` (walks `Error.cause`, depth-capped against cycles) and
`createConsoleErrorReporter` (a pair of handlers pre-wired to `KohakuHostDeps.onError` and
`ComposeObserver.onError`'s exact signatures) give a generated project sensible default logging.
`kohaku init` wires both hooks in the generated `app.ts`, gated by a new `KOHAKU_DEBUG` env var
(documented in `.env.example`): unset/any other value keeps today's one-line summaries, `KOHAKU_DEBUG=1`
prints the full cause chain and stack trace instead.
