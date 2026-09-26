/**
 * `e.message` for an Error, else its `String()` form. This is a deliberate duplicate of host-core's
 * `errorMessage` (see packages/host-core/src/errors.ts): the dependency direction fixed by AGENTS.md is
 * `composer -> host-core`, so composer can never import host-core, even for a one-line helper. Keep this
 * body in sync with host-core's copy if it ever changes.
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Whether `e` explicitly opts in to having its own message shown to a client — a narrower, opt-in marker
 * (a readonly `clientSafe: true` property) than host-core's `isTypedHostError`, which treats *any* Error
 * carrying a string `code` property as safe. That broader convention is fine for kohaku's own internal
 * errors (SpecError / ComposeError / QueryRefError and the governance/capability errors that follow the
 * same pattern), but the cause this function inspects (refs.ts's SEMANTIC_FAILED enrichment) can be
 * *anything* a product's own `SemanticPort.resolveQuery` implementation throws — and a real implementation
 * commonly delegates to a database/filesystem/HTTP client (pg / fs / ioredis / fetch, ...) whose own error
 * types also carry a string `code` (e.g. `ECONNREFUSED`, `ENOENT`) while their `message` can contain
 * hostnames, file paths, table names, or other connection internals that must never reach a client
 * verbatim. Gating on `code` alone would silently leak those. `clientSafe` requires the throwing code to
 * make an explicit, individual decision instead: a `SemanticPort` implementer should set
 * `readonly clientSafe = true` only on an error class whose `message` is written to be end-user-safe (see
 * `@kohaku-ui/semantic-llm`'s `UnknownIntentError` for an example) — never on a caught/rethrown error from
 * a lower-level client library.
 *
 * composer cannot import host-core (the dependency direction fixed by AGENTS.md is composer -> host-core),
 * hence this being a local duplicate rather than a shared helper.
 */
export function isClientSafeCause(e: unknown): e is Error & { clientSafe: true } {
  return e instanceof Error && (e as { clientSafe?: unknown }).clientSafe === true;
}
