import { describe, expect, it } from "vitest";
import { ProvenanceSchema } from "../src/index.js";

const BASE = { tier: "L1", composedBy: "composer", cache: "miss" } as const;

// zod 4.6 made z.iso.datetime() require seconds by default, which silently changed the accepted shape of
// provenance.composedAt (and happened to close a gap with Python's own datetime pattern, which already
// required seconds). Nothing in either language pinned this before, so a future dependency bump could
// reopen the gap unnoticed. This test pins the current (seconds-required) behavior.
describe("ProvenanceSchema.composedAt: zod's z.iso.datetime() requires seconds", () => {
  it("rejects a seconds-less value", () => {
    const result = ProvenanceSchema.safeParse({ ...BASE, composedAt: "2026-01-01T00:00Z" });
    expect(result.success).toBe(false);
  });

  it("accepts a value with seconds", () => {
    const result = ProvenanceSchema.safeParse({ ...BASE, composedAt: "2026-01-01T00:00:00Z" });
    expect(result.success).toBe(true);
  });
});

// Task 3 (M-1/M-2): generatorVersion and kit are both MAY (spec/SPEC.md §2.1). Neither is required,
// and both must round-trip when present so the composer can stamp them and a sandbox can read them back.
describe("ProvenanceSchema.generatorVersion / kit", () => {
  it("accepts provenance with neither field (both optional, no behavior change)", () => {
    const result = ProvenanceSchema.safeParse(BASE);
    expect(result.success).toBe(true);
  });

  it("accepts generatorVersion alone", () => {
    const result = ProvenanceSchema.safeParse({ ...BASE, generatorVersion: "p12/gpt-5" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.generatorVersion).toBe("p12/gpt-5");
  });

  it("accepts kit ({id, version}) alone", () => {
    const result = ProvenanceSchema.safeParse({ ...BASE, kit: { id: "kohaku", version: "1" } });
    expect(result.success).toBe(true);
    expect(result.success && result.data.kit).toEqual({ id: "kohaku", version: "1" });
  });

  it("rejects a kit object missing version (both id and version are required once kit is present)", () => {
    const result = ProvenanceSchema.safeParse({ ...BASE, kit: { id: "kohaku" } });
    expect(result.success).toBe(false);
  });

  it("accepts both fields together", () => {
    const result = ProvenanceSchema.safeParse({
      ...BASE,
      generatorVersion: "p12/gpt-5",
      kit: { id: "acme", version: "3" },
    });
    expect(result.success).toBe(true);
  });
});
