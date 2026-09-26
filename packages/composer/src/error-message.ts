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
 * Whether `e` is a "typed" error whose message is safe to expose to a client as-is — the convention this
 * codebase uses for a deliberately thrown Error carrying a string `code` property (see host-core's
 * `isTypedHostError` for the full rationale; this is a narrower duplicate of that same check, scoped to
 * what refs.ts needs for SEMANTIC_FAILED message enrichment). composer cannot import host-core (the
 * dependency direction fixed by AGENTS.md is composer -> host-core), and a SemanticPort.resolveQuery
 * failure can come from any product's own port implementation (not just @kohaku-ui/semantic-llm), so this
 * deliberately checks the general "string code property" shape rather than importing any specific error class.
 */
export function isTypedCause(e: unknown): e is Error & { code: string } {
  return e instanceof Error && typeof (e as { code?: unknown }).code === "string";
}
