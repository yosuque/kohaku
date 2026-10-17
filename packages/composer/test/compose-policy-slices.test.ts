import { describe, expect, it } from "vitest";
import type {
  ComposeAssemblePolicy,
  ComposeCachePolicy,
  ComposeGenerationPolicy,
  ComposeL1Policy,
  ComposeL2Policy,
  ComposePolicy,
  ComposeTierPolicy,
} from "../src/index.js";

// Contract: `ComposePolicy` is exactly the union of its six concern slices. A field added to
// `ComposePolicy` without landing in a slice (or the reverse) is a compile-time error here, so the
// slice split cannot drift from the public type.

type Slices = ComposeCachePolicy &
  ComposeTierPolicy &
  ComposeGenerationPolicy &
  ComposeL1Policy &
  ComposeL2Policy &
  ComposeAssemblePolicy;

type MissingFromSlices = Exclude<keyof ComposePolicy, keyof Slices>;
type MissingFromPolicy = Exclude<keyof Slices, keyof ComposePolicy>;

const noFieldMissingFromSlices: [MissingFromSlices] extends [never] ? true : never = true;
const noFieldMissingFromPolicy: [MissingFromPolicy] extends [never] ? true : never = true;

// Every key of `ComposePolicy` must be listed (a missing or extra key fails the Record type), and the
// same object must also satisfy the slices' key set in both directions.
const fields: Record<keyof ComposePolicy, true> = {
  cacheMode: true,
  cacheFailure: true,
  ttlSeconds: true,
  generatorVersion: true,
  fixedSpecs: true,
  allowL2: true,
  routeTier: true,
  budget: true,
  maxRepairAttempts: true,
  outputLanguage: true,
  effort: true,
  selectComponents: true,
  fewShot: true,
  refConstraint: true,
  designSystem: true,
  l2Smoke: true,
  extraRules: true,
};
const slices: Record<keyof Slices, true> = fields;
const policyKeys: Record<keyof ComposePolicy, true> = slices;

describe("ComposePolicy slices", () => {
  it("is exactly the union of its six concern slices (17 fields)", () => {
    expect(noFieldMissingFromSlices).toBe(true);
    expect(noFieldMissingFromPolicy).toBe(true);
    expect(Object.keys(policyKeys)).toHaveLength(17);
    expect(Object.keys(fields).length).toBe(17);
  });
});
