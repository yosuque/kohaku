import { ComposeError } from "@kohaku-ui/composer";
import { QueryRefError, SpecError } from "@kohaku-ui/spec-core";

/**
 * A "typed" error the host's own code (spec-core / composer / lineage / host-core / host-mcp-apps) produced
 * deliberately, with a message safe and useful to show a client as-is: SpecError (Spec parse/patch/validation
 * failures), ComposeError (composition-pipeline failures), QueryRefError (query:// URI parse failures), and
 * more generally any Error carrying a string `code` property — the convention every governance/capability
 * error in this codebase already follows (PromotionNotPublishedError, FixationUnsupportedError, the
 * candidate-store "unknown artifact" error, etc.), and the cheapest way for a call site's own deliberately
 * thrown `Error` (e.g. host-mcp-apps' "rebuild the renderer" guidance) to opt in without a dedicated class.
 * Distinguished from an arbitrary/unexpected exception (a raw Error surfacing from DomainPort.invoke, a
 * downstream library failure, etc.), whose message may leak internals (SQL fragments, stack-trace text,
 * library-internal wording) and must not reach the client verbatim. Shared by both host profiles so a 5xx
 * (REST's INTERNAL/COMPOSE_FAILED) or MCP tool-error response is fixed-text for the untyped case while a
 * typed error's own message still passes through.
 */
export function isTypedHostError(e: unknown): boolean {
  if (e instanceof SpecError || e instanceof ComposeError || e instanceof QueryRefError) return true;
  return e instanceof Error && typeof (e as { code?: unknown }).code === "string";
}

/**
 * `e.message` for an Error, else its `String()` form. Shared building block for both host profiles'
 * observability-hook payloads and for the "typed error message passes through" half of clientMessageFor
 * below (the same idiom was independently copied at 7 call sites across host-rest / host-mcp-apps before
 * this was extracted — see the H3 finding).
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The client-visible message for a caught exception: the error's own message when it is a "typed" host
 * error (see isTypedHostError's doc comment for the safe/unsafe distinction), otherwise `fallback` — an
 * arbitrary/unexpected exception's message must never reach the client verbatim (it may carry internals such
 * as SQL fragments, stack-trace text, or library-internal wording). Shared building block for both host
 * profiles' failure-path responses (REST's per-route INTENT_INVALID / COMPOSE_FAILED / FIXATION_INTERNAL_ERROR
 * fallbacks, MCP's TOOL_INTERNAL_ERROR fallback); the original error still reaches the observability hook via
 * notifyHook/reportHostError regardless, so nothing is lost for diagnosis.
 */
export function clientMessageFor(e: unknown, fallback: string): string {
  return isTypedHostError(e) ? errorMessage(e) : fallback;
}

/**
 * Calls an optional observability hook with `info`, swallowing both a synchronous throw and a rejected
 * Promise. Shared building block for both host profiles' failure-path observability (REST's onError /
 * MCP's onError): silent when the hook is unwired, and a throw from the hook itself must never propagate to
 * the delivery or self-healing path it is reporting on.
 */
export async function notifyHook<I>(
  hook: ((info: I) => void | Promise<void>) | undefined,
  info: I,
): Promise<void> {
  if (hook == null) return;
  try {
    await hook(info);
  } catch {
    // A failure of the observation-only hook must not propagate.
  }
}

/**
 * Runs `fn`, and on failure runs `onFailure(error)` instead of rethrowing. Shared building block for
 * fail-open audit recording (view-recorder.ts's recordComposedResult, consumed by both host profiles, and
 * host-mcp-apps' `${prefix}_event` interacted recording): prioritizes delivery availability by swallowing a
 * recording failure rather than letting it take down an otherwise-successful response.
 */
export async function failOpen(
  fn: () => Promise<void>,
  onFailure: (error: unknown) => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    await onFailure(e);
  }
}
