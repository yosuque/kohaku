import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KohakuPolicyFileSchema } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";

/**
 * Accept/reject coverage for the hand-written policy-file examples (spec/examples/policy/{valid,invalid}).
 * Shared fixtures with Python's parity test (kohaku.spec.policy, task 3's test_policy_examples.py):
 * both languages must accept exactly the "valid" set and reject exactly the "invalid" set, from the
 * same files, so a schema drift between the two Zod/Pydantic ports is caught here rather than only in
 * each language's own hand-written unit tests.
 */
const EXAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../examples/policy");

function exampleNames(kind: "valid" | "invalid"): string[] {
  return readdirSync(join(EXAMPLES_DIR, kind)).filter((f) => f.endsWith(".json"));
}

function readExample(kind: "valid" | "invalid", name: string): unknown {
  return JSON.parse(readFileSync(join(EXAMPLES_DIR, kind, name), "utf8"));
}

describe("policy file examples (spec/examples/policy)", () => {
  it("has at least one example in each directory (a directory typo would otherwise pass vacuously)", () => {
    expect(exampleNames("valid").length).toBeGreaterThan(0);
    expect(exampleNames("invalid").length).toBeGreaterThan(0);
  });

  it.each(exampleNames("valid"))("accepts valid/%s", (name) => {
    const result = KohakuPolicyFileSchema.safeParse(readExample("valid", name));
    expect(result.success, result.success ? "" : JSON.stringify(result.error.issues)).toBe(true);
  });

  it.each(exampleNames("invalid"))("rejects invalid/%s", (name) => {
    expect(KohakuPolicyFileSchema.safeParse(readExample("invalid", name)).success).toBe(false);
  });
});
