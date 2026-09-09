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
