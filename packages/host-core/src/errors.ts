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
 * fail-open audit recording (REST's safeRecord / MCP's composeAndAudit): prioritizes delivery availability by
 * swallowing a recording failure rather than letting it take down an otherwise-successful response.
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
