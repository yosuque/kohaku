import { describe, expect, it } from "vitest";
import { cacheKey, computeStructureHash, type UISpec } from "../src/index.js";

const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L0", composedBy: "test", cache: "hit" } as const;

describe("cacheKey: policyFingerprint (7th component)", () => {
  const base = { intentHash: "sha256:aaa", dataVersion: "v1", catalogFingerprint: "cat1" };

  it("omitting policyFingerprint keeps the key byte-identical to before this field existed (5 components)", () => {
    expect(cacheKey(base)).toBe("kohaku:0.2:sha256:aaa:v1:cat1");
  });

  it("an empty-string policyFingerprint is treated the same as omitted (key unchanged)", () => {
    expect(cacheKey({ ...base, policyFingerprint: "" })).toBe(cacheKey(base));
  });

  it("generatorVersion alone still produces the legacy 6-component key (unaffected by the new field)", () => {
    expect(cacheKey({ ...base, generatorVersion: "gv1" })).toBe("kohaku:0.2:sha256:aaa:v1:cat1:gv1");
  });

  it("policyFingerprint alone inserts a '-' placeholder in the generatorVersion slot (7 components)", () => {
    expect(cacheKey({ ...base, policyFingerprint: "pf1" })).toBe("kohaku:0.2:sha256:aaa:v1:cat1:-:pf1");
  });

  it("both generatorVersion and policyFingerprint are appended in order (7 components)", () => {
    expect(cacheKey({ ...base, generatorVersion: "gv1", policyFingerprint: "pf1" })).toBe(
      "kohaku:0.2:sha256:aaa:v1:cat1:gv1:pf1",
    );
  });

  it("a generatorVersion-only key never collides with a policyFingerprint-only key sharing the same string", () => {
    const byGeneratorVersion = cacheKey({ ...base, generatorVersion: "pf1" });
    const byPolicyFingerprint = cacheKey({ ...base, policyFingerprint: "pf1" });
    expect(byGeneratorVersion).not.toBe(byPolicyFingerprint);
  });
});

describe("computeStructureHash: memoization by components reference", () => {
  const spec: UISpec = {
    kohaku: "0.2",
    intent: INTENT,
    dataVersion: "v1",
    components: [{ id: "root", type: "layout.stack", props: {} }],
    events: [],
    provenance: PROVENANCE,
  };

  it("repeated calls against the exact same Spec object return the identical memoized Promise", () => {
    const first = computeStructureHash(spec);
    const second = computeStructureHash(spec);
    expect(second).toBe(first);
  });

  it("a Spec with a different components array reference is not affected by another Spec's memo entry", async () => {
    const other: UISpec = { ...spec, components: [...spec.components] };
    const h1 = await computeStructureHash(spec);
    const h2 = await computeStructureHash(other);
    // Same content -> same hash value, but computed independently (different array reference / memo entry).
    expect(h2).toBe(h1);
    expect(computeStructureHash(other)).not.toBe(computeStructureHash(spec));
  });

  it("reusing the same components array with a different state recomputes rather than returning a stale hash", async () => {
    const withState: UISpec = { ...spec, state: { tab: "a" } };
    const plainHash = await computeStructureHash(spec);
    const stateHash = await computeStructureHash(withState);
    expect(stateHash).not.toBe(plainHash);
  });
});
