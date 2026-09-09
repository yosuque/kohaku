/**
 * Named truncation lengths for the sandbox (replaces the magic numbers previously scattered across
 * runtime.ts / host-bridge.ts / smoke/index.ts — lineage already named its scan windows the same way).
 *
 * These are imported normally by non-guest code (host-bridge.ts, srcdoc.ts, smoke/index.ts). The guest
 * closures (worker-shim.ts / dom-applier.ts) cannot import this module at all — per the guest convention
 * they are self-contained functions with zero imports, stringified via Function.prototype.toString() and
 * evaluated in an isolated Worker/vm context where this module does not exist — so they instead define their
 * own local literal constants with a comment pointing back here. Keep the values below and those literals in
 * sync by hand.
 */

/** Guest-originated telemetry.report `detail` is truncated to this many characters before it leaves the guest (worker or applier). */
export const TELEMETRY_DETAIL_MAX_CHARS = 300;

/** How much of a disallowed `$ref` is echoed back in a "ref not allowed" denial detail. */
export const DENIED_REF_PREVIEW_MAX_CHARS = 120;

/** host-bridge's sanitizeDetail truncation, applied after control characters are collapsed to spaces. */
export const SANITIZED_DETAIL_MAX_CHARS = 500;

/** smoke's runtimeErrorIssue truncation of the raw error message embedded in the repair-feedback string. */
export const SMOKE_RUNTIME_ERROR_DETAIL_MAX_CHARS = 300;
