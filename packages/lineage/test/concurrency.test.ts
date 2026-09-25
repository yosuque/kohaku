import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/promotion/concurrency.js";

/** A manually-releasable gate: fn suspends on it until the test calls its resolver. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("mapWithConcurrency", () => {
  it("resolves to [] for empty input without calling fn", async () => {
    let calls = 0;
    const result = await mapWithConcurrency([], 4, async () => {
      calls++;
      return 1;
    });
    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });

  it("preserves result order by index regardless of completion order", async () => {
    const gates = [gate(), gate(), gate()];
    const resultPromise = mapWithConcurrency([0, 1, 2], 3, async (item) => {
      await gates[item]!.promise;
      return item * 10;
    });
    // Release out of order: 2, then 0, then 1.
    gates[2]!.release();
    gates[0]!.release();
    gates[1]!.release();
    expect(await resultPromise).toEqual([0, 10, 20]);
  });

  it("never runs more than `limit` calls concurrently", async () => {
    const items = [0, 1, 2, 3, 4];
    let active = 0;
    let maxActive = 0;
    const gates = items.map(() => gate());
    const resultPromise = mapWithConcurrency(items, 2, async (item) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await gates[item]!.promise;
      active--;
      return item;
    });
    // Let the first wave (limit=2) start and suspend on their gates.
    await Promise.resolve();
    await Promise.resolve();
    expect(active).toBe(2);

    // Release sequentially; concurrency must never exceed 2 as each release lets the next item start.
    for (let i = 0; i < items.length; i++) {
      gates[i]!.release();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(await resultPromise).toEqual(items);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("a limit >= items.length runs every item immediately (Promise.all-equivalent)", async () => {
    const items = [1, 2, 3];
    let concurrent = 0;
    let maxConcurrent = 0;
    const result = await mapWithConcurrency(items, 10, async (item) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      concurrent--;
      return item;
    });
    expect(result).toEqual(items);
    expect(maxConcurrent).toBe(3);
  });

  it("a rejection from one item rejects the whole call (Promise.all-style), not swallowed", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error("boom");
        return item;
      }),
    ).rejects.toThrow("boom");
  });

  it("treats a non-positive or non-finite limit as 1 (never unbounded, never zero workers)", async () => {
    for (const limit of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      let active = 0;
      let maxActive = 0;
      const result = await mapWithConcurrency([1, 2, 3], limit, async (item) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
        return item;
      });
      expect(result).toEqual([1, 2, 3]);
      expect(maxActive).toBe(1);
    }
  });
});
