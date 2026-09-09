import { SpecError } from "./errors.js";
import { type SpecPatch, SpecPatchSchema } from "./schema/patch.js";
import { type UISpec, UISpecSchema } from "./schema/spec.js";
import { hasErrors, type SpecIssue, validateSpecStructure } from "./validate.js";

export type SafeParseResult =
  | { ok: true; spec: UISpec; warnings: SpecIssue[] }
  | { ok: false; issues: SpecIssue[]; zodError?: string };

/** Zod parse + structural validation. Warnings (ORPHAN, etc.) pass through; only errors cause failure. */
export function safeParseSpec(input: unknown): SafeParseResult {
  const parsed = UISpecSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: [],
      zodError: parsed.error.message,
    };
  }
  const issues = validateSpecStructure(parsed.data);
  if (hasErrors(issues)) {
    return { ok: false, issues: issues.filter((i) => i.severity === "error") };
  }
  return {
    ok: true,
    spec: parsed.data,
    warnings: issues.filter((i) => i.severity === "warning"),
  };
}

export function parseSpec(input: unknown): UISpec {
  const result = safeParseSpec(input);
  if (!result.ok) {
    if (result.zodError != null) {
      throw new SpecError("PARSE_FAILED", `UI Spec schema validation failed: ${result.zodError}`);
    }
    throw new SpecError(
      "STRUCTURE_INVALID",
      `UI Spec structure validation failed: ${result.issues.map((i) => `${i.code}: ${i.message}`).join("; ")}`,
      result.issues,
    );
  }
  return result.spec;
}

export type SafeParsePatchResult = { ok: true; patch: SpecPatch } | { ok: false; zodError: string };

/**
 * Zod parse of a SpecPatch. Validates only the wire-shape types and value ranges (it does not
 * structurally validate the patch on its own — validateSpecStructure runs inside applyPatch after
 * application; we create no second source of truth).
 */
export function safeParsePatch(input: unknown): SafeParsePatchResult {
  const parsed = SpecPatchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, zodError: parsed.error.message };
  return { ok: true, patch: parsed.data };
}

export function parsePatch(input: unknown): SpecPatch {
  const result = safeParsePatch(input);
  if (!result.ok) {
    throw new SpecError("PATCH_PARSE_FAILED", `SpecPatch schema validation failed: ${result.zodError}`);
  }
  return result.patch;
}
