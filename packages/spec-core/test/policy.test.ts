import { describe, expect, it } from "vitest";
import {
  computePolicyId,
  KohakuPolicyFileSchema,
  mergePolicySections,
  type PolicySection,
} from "../src/schema/policy.js";

// File-based (spec/examples/policy/{valid,invalid}) accept/reject coverage lives in
// spec/test/policy-examples.test.ts instead of here: spec-core's src is deliberately
// environment-neutral (AGENTS.md — no @types/node), and its test tsconfig follows suit, so a test
// here cannot use node:fs. This file covers the schema's in-memory shape plus mergePolicySections /
// computePolicyId with literal objects only.

describe("KohakuPolicyFileSchema", () => {
  it("accepts the minimal shape (empty defaults, no tenants)", () => {
    expect(KohakuPolicyFileSchema.safeParse({ version: 1, defaults: {} }).success).toBe(true);
  });

  it("accepts a fully populated section", () => {
    const result = KohakuPolicyFileSchema.safeParse({
      version: 1,
      label: "demo",
      defaults: {
        compose: {
          allowL2: true,
          maxRepairAttempts: 1,
          refConstraint: "validate",
          effort: { l1: "low", l2: "high" },
          outputLanguage: "English",
          cacheFailure: "closed",
          ttlSeconds: 60,
          budget: { perCompose: { stopAfterTokens: 1000 }, deadlineMs: 5000, dailyTokens: 100000 },
        },
        rateLimits: {
          compose: { capacity: 10, refillPerSecond: 1 },
          action: { capacity: 5, refillPerSecond: 0.5 },
          resolve: { capacity: 20, refillPerSecond: 2 },
        },
        governance: { roles: { admin: ["*"] } },
      },
      tenants: { "tenant-a": { compose: { allowL2: false } } },
    });
    expect(result.success, result.success ? "" : JSON.stringify((result as { error?: unknown }).error)).toBe(
      true,
    );
  });

  it("rejects a version other than 1", () => {
    expect(KohakuPolicyFileSchema.safeParse({ version: 2, defaults: {} }).success).toBe(false);
  });

  it("rejects an unknown top-level key", () => {
    expect(KohakuPolicyFileSchema.safeParse({ version: 1, defaults: {}, bogus: true }).success).toBe(false);
  });

  it("rejects an unknown key inside defaults.compose", () => {
    expect(
      KohakuPolicyFileSchema.safeParse({
        version: 1,
        defaults: { compose: { allowL2: true, bogus: 1 } },
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown key inside a tenant section", () => {
    expect(
      KohakuPolicyFileSchema.safeParse({
        version: 1,
        defaults: {},
        tenants: { "tenant-a": { bogus: true } },
      }).success,
    ).toBe(false);
  });

  it("rejects a negative rate-limit capacity", () => {
    expect(
      KohakuPolicyFileSchema.safeParse({
        version: 1,
        defaults: { rateLimits: { compose: { capacity: -1, refillPerSecond: 1 } } },
      }).success,
    ).toBe(false);
  });

  it("has no field for a function-shaped ComposePolicy setting (routeTier is not a valid key)", () => {
    expect(
      KohakuPolicyFileSchema.safeParse({
        version: 1,
        defaults: { compose: { routeTier: "L2" } },
      }).success,
    ).toBe(false);
  });
});

describe("mergePolicySections", () => {
  it("merges disjoint top-level keys from both sides", () => {
    const base: PolicySection = { compose: { allowL2: true } };
    const override: PolicySection = { governance: { roles: { admin: ["*"] } } };
    expect(mergePolicySections(base, override)).toEqual({
      compose: { allowL2: true },
      governance: { roles: { admin: ["*"] } },
    });
  });

  it("recursively merges nested objects (compose.budget) rather than replacing the whole compose object", () => {
    const base: PolicySection = {
      compose: { allowL2: true, budget: { perCompose: { stopAfterTokens: 20000 } } },
    };
    const override: PolicySection = { compose: { budget: { dailyTokens: 1000 } } };
    expect(mergePolicySections(base, override)).toEqual({
      compose: {
        allowL2: true,
        budget: { perCompose: { stopAfterTokens: 20000 }, dailyTokens: 1000 },
      },
    });
  });

  it("scalar override replaces base's value rather than merging", () => {
    const base: PolicySection = { compose: { allowL2: false } };
    const override: PolicySection = { compose: { allowL2: true } };
    expect(mergePolicySections(base, override)).toEqual({ compose: { allowL2: true } });
  });

  it("an array on override replaces base's array wholesale (never concatenated)", () => {
    const base: PolicySection = { governance: { roles: { admin: ["lineage.read"] } } };
    const override: PolicySection = { governance: { roles: { admin: ["*"] } } };
    expect(mergePolicySections(base, override)).toEqual({ governance: { roles: { admin: ["*"] } } });
  });

  it("a role present only in base survives an override that touches a different role", () => {
    const base: PolicySection = { governance: { roles: { admin: ["*"], viewer: ["lineage.read"] } } };
    const override: PolicySection = {
      governance: { roles: { viewer: ["lineage.read", "analytics.read"] } },
    };
    expect(mergePolicySections(base, override)).toEqual({
      governance: { roles: { admin: ["*"], viewer: ["lineage.read", "analytics.read"] } },
    });
  });

  it("an empty override returns base's shape unchanged", () => {
    const base: PolicySection = { compose: { allowL2: true } };
    expect(mergePolicySections(base, {})).toEqual(base);
  });
});

describe("computePolicyId", () => {
  it("is deterministic for the same content", async () => {
    const file = KohakuPolicyFileSchema.parse({ version: 1, defaults: { compose: { allowL2: true } } });
    expect(await computePolicyId(file)).toBe(await computePolicyId(file));
  });

  it("has the sha256:<hex> shape (matching computeIntentHash/computeSpecHash)", async () => {
    const file = KohakuPolicyFileSchema.parse({ version: 1, defaults: {} });
    expect(await computePolicyId(file)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("differs when the content differs", async () => {
    const a = KohakuPolicyFileSchema.parse({ version: 1, defaults: { compose: { allowL2: true } } });
    const b = KohakuPolicyFileSchema.parse({ version: 1, defaults: { compose: { allowL2: false } } });
    expect(await computePolicyId(a)).not.toBe(await computePolicyId(b));
  });

  it("is unaffected by source key order (object-key order is not part of the file's meaning)", async () => {
    const a = KohakuPolicyFileSchema.parse({
      version: 1,
      defaults: { compose: { allowL2: true, maxRepairAttempts: 2 } },
    });
    const b = KohakuPolicyFileSchema.parse({
      version: 1,
      defaults: { compose: { maxRepairAttempts: 2, allowL2: true } },
    });
    expect(await computePolicyId(a)).toBe(await computePolicyId(b));
  });
});
