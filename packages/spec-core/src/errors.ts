import type { HostErrorCode } from "./rest-errors.js";
import type { SpecIssue } from "./validate.js";

export type SpecErrorCode =
  | "PARSE_FAILED"
  | "STRUCTURE_INVALID"
  | "PATCH_PARSE_FAILED"
  | "PATCH_BASE_MISMATCH"
  | "PATCH_APPLY_FAILED";

/** Structured error with a code. Conformance tests validate against the code. */
export class SpecError extends Error {
  readonly code: SpecErrorCode;
  readonly issues: SpecIssue[];

  constructor(code: SpecErrorCode, message: string, issues: SpecIssue[] = []) {
    super(message);
    this.name = "SpecError";
    this.code = code;
    this.issues = issues;
  }
}

/** One reason a directly-specified Intent (`kind: "intent"`) failed `SemanticPort.validateIntent`. */
export interface IntentValidationIssue {
  /** Dot-separated path into `params` (empty string for a whole-Intent problem, e.g. an unknown canonical). */
  path: string;
  /** Client-safe explanation. May name the Intent / param, but must never include a stack trace or raw internal values. */
  message: string;
}

/**
 * Thrown by `SemanticPort.validateIntent` (an optional method — see `ports.ts`) when a directly-specified
 * Intent fails validation: an unknown canonical, an unknown param key, or a param value that fails the
 * Intent's own schema. `code` reuses the existing `HostErrorCode` "INTENT_INVALID" (SPEC §6.1) rather than
 * minting a new one, so host-rest / host-mcp-apps map it the same way they already map other 422s (and, by
 * carrying a string `code`, it is automatically a "typed" host error per host-core's `isTypedHostError` —
 * its own `message` passes through to the client instead of a fixed fallback string). `message` and every
 * issue's `message` must be safe to show a client as-is.
 */
export class IntentValidationError extends Error {
  readonly code: Extract<HostErrorCode, "INTENT_INVALID"> = "INTENT_INVALID";
  readonly issues: IntentValidationIssue[];

  constructor(message: string, issues: IntentValidationIssue[] = []) {
    super(message);
    this.name = "IntentValidationError";
    this.issues = issues;
  }
}
