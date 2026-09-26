import { ComposeError, type ComposeErrorContext } from "@kohaku-ui/composer";
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

/** Default depth cap for formatErrorChain's `cause` walk — see its doc for why a cap exists at all. */
const DEFAULT_MAX_CHAIN_DEPTH = 10;

/**
 * Formats `err`'s full `cause` chain (the ES2022 `Error.cause` convention) as a single log-friendly line:
 * "name: message" for `err` itself, then for each error it is caused by, joined by " <- " so the immediate
 * failure reads first and its root cause last. A non-Error value — either `err` itself or a link partway
 * through the chain — is rendered with `String()` and ends the walk there (a non-Error has no `.cause` of
 * its own to keep following). Stops after `maxDepth` links regardless of whether the chain is actually
 * exhausted, so a circular or unexpectedly long `cause` chain can never make this loop forever or produce
 * an unbounded string.
 */
export function formatErrorChain(err: unknown, maxDepth = DEFAULT_MAX_CHAIN_DEPTH): string {
  const segments: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < maxDepth && current != null; depth += 1) {
    if (!(current instanceof Error)) {
      segments.push(String(current));
      break;
    }
    segments.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }
  return segments.join(" <- ");
}

export interface ConsoleErrorReporterOptions {
  /**
   * Verbose mode: each logged line becomes the full `cause` chain (formatErrorChain) plus the top error's
   * stack trace, instead of a one-line "prefix: message" summary. Default false. This function never reads
   * an environment variable itself (e.g. KOHAKU_DEBUG) — resolving `debug` from one is the caller's job
   * (see `kohaku init`'s generated app.ts and apps/sample-api's wiring), which keeps this function usable
   * outside a Node/env-var environment too.
   */
  debug?: boolean;
  /** Where to write each formatted line. Default `console.error`. Injectable for tests or a custom log sink. */
  log?: (line: string) => void;
}

export interface ConsoleErrorReporter {
  /** Matches `KohakuHostDeps.onError` (host-rest) verbatim — pass as `onError` directly. */
  host: (info: { endpoint: string; requestId: string; error: unknown }) => void;
  /** Matches `ComposeObserver.onError` (composer) verbatim — pass as `observer.onError` directly. */
  compose: (ctx: ComposeErrorContext, error: unknown) => void;
}

/**
 * Builds a pair of `console.error`-backed handlers pre-wired to `KohakuHostDeps.onError` and
 * `ComposeObserver.onError`'s exact signatures — the smallest reasonable default for a generated project
 * (`kohaku init`) or a demo host that has not wired its own logging/metrics yet. A product with real
 * observability infrastructure should supply its own hooks instead; this exists so "what actually went
 * wrong" is visible on stderr out of the box rather than only inferable from an HTTP 500.
 */
export function createConsoleErrorReporter(options: ConsoleErrorReporterOptions = {}): ConsoleErrorReporter {
  const { debug = false, log = (line: string): void => console.error(line) } = options;

  function writeLine(prefix: string, error: unknown): void {
    if (!debug) {
      log(`${prefix}: ${errorMessage(error)}`);
      return;
    }
    const lines = [`${prefix}: ${formatErrorChain(error)}`];
    if (error instanceof Error && error.stack != null) lines.push(error.stack);
    log(lines.join("\n"));
  }

  return {
    host: (info) => {
      writeLine(`[kohaku] ${info.endpoint} (request ${info.requestId})`, info.error);
    },
    compose: (ctx, error) => {
      // A "fallback"/"cancelled" phase carries no thrown exception (error is undefined for most failure
      // kinds) — the failure is described by ctx.reason instead. "hard"/"cache" always carry the causing
      // exception in `error`. See ComposeErrorContext's own doc for the full phase/field contract.
      writeLine(`[kohaku] compose ${ctx.phase}`, error ?? ctx.reason ?? "unknown failure");
    },
  };
}
