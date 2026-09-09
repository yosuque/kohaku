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
