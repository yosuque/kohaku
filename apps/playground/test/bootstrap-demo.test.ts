import { describe, expect, it, vi } from "vitest";
import { bootstrapDemoState } from "../src/host/bootstrap-demo.js";
import { createPlaygroundHost } from "../src/host/create-host.js";
import { SCENARIOS } from "../src/scenarios.js";

describe("host/bootstrap-demo.ts", () => {
  it("skips every promotion/fixation scenario (no recorded fixtures) and logs why, without throwing", async () => {
    const host = await createPlaygroundHost({});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await expect(bootstrapDemoState(host)).resolves.toBeUndefined();
      const governed = SCENARIOS.filter((s) => s.kind === "promotion" || s.kind === "fixation");
      expect(governed.length).toBeGreaterThan(0);
      for (const scenario of governed) {
        expect(info.mock.calls.some((call) => String(call[0]).includes(scenario.id))).toBe(true);
      }
      // No compose call should have happened (no fixture -> skipped before the loop) -> lineage stays empty.
      expect(await host.lineage.list()).toHaveLength(0);
    } finally {
      info.mockRestore();
    }
  });
});
