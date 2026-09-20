/**
 * `e.message` for an Error, else its `String()` form. This is a deliberate duplicate of host-core's
 * `errorMessage` (see packages/host-core/src/errors.ts): the dependency direction fixed by AGENTS.md is
 * `composer -> host-core`, so composer can never import host-core, even for a one-line helper. Keep this
 * body in sync with host-core's copy if it ever changes.
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
