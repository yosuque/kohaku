import { describe, expect, it } from "vitest";
import {
  cacheKey,
  canonicalStringify,
  combineDataVersions,
  computeIntentHash,
  finalizeIntent,
  normalizeIntent,
} from "../src/index.js";

describe("Intent normalization and hashing", () => {
  it("produces the same hash even when params key order differs", async () => {
    const a = await computeIntentHash({
      canonical: "sales.quarterly_summary",
      params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
    });
    const b = await computeIntentHash({
      canonical: "sales.quarterly_summary",
      params: { groupBy: "region", quarter: 3, fiscalYear: 2026 },
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("produces a different hash when params values differ", async () => {
    const a = await computeIntentHash({ canonical: "sales.trend", params: { quarter: 3 } });
    const b = await computeIntentHash({ canonical: "sales.trend", params: { quarter: 4 } });
    expect(a).not.toBe(b);
  });

  it("nested objects are also deeply sorted", () => {
    const n = normalizeIntent({
      canonical: "x.y",
      params: { b: { z: 1, a: 2 }, a: [{ d: 1, c: 2 }] },
    });
    expect(canonicalStringify(n.params)).toBe('{"a":[{"c":2,"d":1}],"b":{"a":2,"z":1}}');
  });

  it("finalizeIntent returns normalized params and a hash", async () => {
    const intent = await finalizeIntent({
      canonical: "sales.records",
      params: { region: "japan", limit: 100 },
    });
    expect(Object.keys(intent.params)).toEqual(["limit", "region"]);
    expect(intent.hash).toMatch(/^sha256:/);
  });

  it("finalizeIntent skips recomputation when the input already carries a hash (a CanonicalIntent)", async () => {
    const first = await finalizeIntent({
      canonical: "sales.records",
      params: { region: "japan", limit: 100 },
    });
    // Re-finalizing an already-finalized CanonicalIntent returns the same object (identity-preserving
    // fast path), rather than recomputing an identical hash from scratch.
    const second = await finalizeIntent(first);
    expect(second).toBe(first);
  });
});

describe("cacheKey", () => {
  it("is deterministic and contains all components", () => {
    const key = cacheKey({
      intentHash: "sha256:abc",
      dataVersion: "sales@1",
      catalogFingerprint: "fp1",
    });
    expect(key).toBe("kohaku:0.2:sha256:abc:sales@1:fp1");
  });

  it("matches the legacy 5-component key exactly when generatorVersion is unspecified (backward compatible)", () => {
    const withUndefined = cacheKey({
      intentHash: "sha256:abc",
      dataVersion: "sales@1",
      catalogFingerprint: "fp1",
      generatorVersion: undefined,
    });
    // undefined is not added as a component = identical to the legacy key (introducing it does not blow away existing caches)
    expect(withUndefined).toBe("kohaku:0.2:sha256:abc:sales@1:fp1");
  });

  it("appended as a 6th component at the tail only when generatorVersion is specified", () => {
    const key = cacheKey({
      intentHash: "sha256:abc",
      dataVersion: "sales@1",
      catalogFingerprint: "fp1",
      generatorVersion: "p1/gpt-x",
    });
    expect(key).toBe("kohaku:0.2:sha256:abc:sales@1:fp1:p1/gpt-x");
  });

  it("the key is separated when generatorVersion changes", () => {
    const base = { intentHash: "sha256:abc", dataVersion: "sales@1", catalogFingerprint: "fp1" };
    const v1 = cacheKey({ ...base, generatorVersion: "p1/m" });
    const v2 = cacheKey({ ...base, generatorVersion: "p2/m" });
    expect(v1).not.toBe(v2);
  });

  it("combineDataVersions is order-independent", async () => {
    const a = await combineDataVersions([
      { uri: "kohaku://sales", version: "sales@1" },
      { uri: "kohaku://targets", version: "targets@2" },
    ]);
    const b = await combineDataVersions([
      { uri: "kohaku://targets", version: "targets@2" },
      { uri: "kohaku://sales", version: "sales@1" },
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^multi:[0-9a-f]{16}$/);
  });

  it("combineDataVersions returns a single element as-is", async () => {
    expect(await combineDataVersions([{ uri: "kohaku://sales", version: "sales@1" }])).toBe("sales@1");
  });

  it("combineDataVersions folds duplicates of the same version and returns the bare single version", async () => {
    // When multiple $refs point at the same data source (a KPI list, etc.), return a single version
    // without turning it into multi: so it can be matched against each $ref's response dataVersion
    // (without deduplication it would always be judged STALE).
    expect(
      await combineDataVersions([
        { uri: "kohaku://sales", version: "sales@1" },
        { uri: "kohaku://sales-mirror", version: "sales@1" },
        { uri: "kohaku://sales-alias", version: "sales@1" },
      ]),
    ).toBe("sales@1");
    expect(
      await combineDataVersions([
        { uri: "kohaku://sales", version: "sales@1" },
        { uri: "kohaku://sales-mirror", version: "sales@1" },
        { uri: "kohaku://targets", version: "targets@2" },
      ]),
    ).toMatch(/^multi:[0-9a-f]{16}$/);
  });

  it("same versions on swapped URIs give different multi: values", async () => {
    // {a: v1, b: v2} and {a: v2, b: v1} carry the same two version strings but denote different
    // data states, so the combined cache-key component must not collapse them onto the same value.
    const swapped1 = await combineDataVersions([
      { uri: "kohaku://a", version: "v1" },
      { uri: "kohaku://b", version: "v2" },
    ]);
    const swapped2 = await combineDataVersions([
      { uri: "kohaku://a", version: "v2" },
      { uri: "kohaku://b", version: "v1" },
    ]);
    expect(swapped1).not.toBe(swapped2);
  });

  it("cross-language golden: a fixed URI/version pair set hashes to a pinned multi: value", async () => {
    // Mirrored verbatim in python/kohaku/tests/spec/test_cache_key.py as a cross-language golden.
    const value = await combineDataVersions([
      { uri: "kohaku://sales-summary", version: "v1" },
      { uri: "kohaku://targets", version: "v2" },
    ]);
    expect(value).toBe("multi:0d9007cd68b518c8");
  });
});
