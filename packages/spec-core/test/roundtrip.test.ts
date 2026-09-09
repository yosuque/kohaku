import { describe, expect, it } from "vitest";
import fixture from "../../../spec/examples/quarterly-sales.spec.json";
import { canonicalStringify, computeIntentHash, parseSpec } from "../src/index.js";

describe("canonical fixture round-trip", () => {
  it("parse → re-serialize preserves the content", () => {
    const spec = parseSpec(fixture);
    expect(JSON.parse(JSON.stringify(spec))).toEqual(fixture);
  });

  it("the fixture's intent.hash matches the actual value computed by computeIntentHash", async () => {
    const spec = parseSpec(fixture);
    const hash = await computeIntentHash({
      canonical: spec.intent.canonical,
      params: spec.intent.params,
    });
    expect(hash).toBe(spec.intent.hash);
  });

  it("parse preserves the normalized props of components", () => {
    const spec = parseSpec(fixture);
    const chart = spec.components.find((c) => c.id === "chart1");
    expect(chart?.type).toBe("presentChart");
    expect(chart?.data?.$ref).toMatch(/^query:\/\/ledger\//);
  });
});

describe("canonicalStringify non-finite number guard", () => {
  // A safeguard for direct calls that bypass parse. NaN / Infinity collapse to null in JSON and would
  // collide on the same hash as a genuine null, breaking determinism.
  it("throws a TypeError when NaN is passed directly", () => {
    expect(() => canonicalStringify(NaN)).toThrow(TypeError);
  });

  it("throws a TypeError even for an object containing a non-finite number", () => {
    expect(() => canonicalStringify({ total: Infinity })).toThrow(TypeError);
  });

  it("negative zero is normalized to 0", () => {
    expect(canonicalStringify(-0)).toBe("0");
    expect(canonicalStringify([-0])).toBe("[0]");
  });
});
