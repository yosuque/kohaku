import { describe, expect, it } from "vitest";
import { loadFixtures, RECORDED_SCENARIO_IDS } from "../src/host/fixtures.js";

describe("host/fixtures.ts", () => {
  it("finds no recorded fixtures today (recording is postponed — see reports/u5-3.md)", () => {
    expect(RECORDED_SCENARIO_IDS.size).toBe(0);
    expect(loadFixtures()).toEqual({});
  });
});
