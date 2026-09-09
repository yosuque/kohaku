import { describe, expect, it } from "vitest";
import fixture from "../../../spec/examples/quarterly-sales.spec.json";
import { diffSpec, parsePatch, parseSpec, SpecError, safeParsePatch, type UISpec } from "../src/index.js";

const base = (): UISpec => parseSpec(fixture);
const HASH = "sha256:" + "0".repeat(64);

describe("parsePatch / safeParsePatch", () => {
  it("diffSpec output survives a JSON round-trip and is restored by parsePatch (round-trip)", () => {
    const prev = base();
    const next: UISpec = {
      ...prev,
      dataVersion: "ledger@2026-06-11T00:00:00Z",
      components: prev.components
        .filter((c) => c.id !== "table1")
        .map((c) => (c.id === "root" ? { ...c, children: ["title", "chart1"] } : c)),
      events: [],
    };
    const wire = JSON.parse(JSON.stringify(diffSpec(prev, next)));
    const patch = parsePatch(wire);
    expect(patch.baseIntentHash).toBe(prev.intent.hash);
    expect(patch.remove).toEqual(["table1"]);
    expect(patch.dataVersion).toBe(next.dataVersion);
  });

  it("rejects baseIntentHash that is not in sha256:<hex64> form", () => {
    const bad = safeParsePatch({ baseIntentHash: "not-a-hash" });
    expect(bad.ok).toBe(false);
  });

  it("carrying bulk data (data.rows) inside upsert is rejected by DataRefSchema .strict()", () => {
    const result = safeParsePatch({
      baseIntentHash: HASH,
      upsert: [
        {
          id: "t1",
          type: "presentSpreadsheet",
          props: {},
          // anything other than $ref (bulk contamination like rows) is rejected by strict — preventing SPEC-DATA-001 from being bypassed
          data: { $ref: "query://sales/summary?fy=2026", rows: [{ region: "japan" }] },
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("refVersions passes null (a deletion directive)", () => {
    const result = safeParsePatch({ baseIntentHash: HASH, refVersions: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch.refVersions).toBeNull();
  });

  it("a minimal patch with baseIntentHash only also passes", () => {
    const result = safeParsePatch({ baseIntentHash: HASH });
    expect(result.ok).toBe(true);
  });

  it("parsePatch throws a SpecError with code PATCH_PARSE_FAILED on an invalid payload", () => {
    try {
      parsePatch({ baseIntentHash: "bad" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SpecError);
      expect((e as SpecError).code).toBe("PATCH_PARSE_FAILED");
    }
  });
});
