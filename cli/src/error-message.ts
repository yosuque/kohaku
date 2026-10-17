/**
 * The one-line message of a caught value: an Error's `message`, anything else stringified. For the runner
 * modules (`conformance.ts`, `explain.ts`, ...), which wrap it in their own context-specific sentence.
 * The registration modules under `src/cli/` use `cli/shared.ts`'s identical helper instead, because the
 * startup-graph test (`test/cli-help.test.ts`) only lets that directory import from itself.
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
