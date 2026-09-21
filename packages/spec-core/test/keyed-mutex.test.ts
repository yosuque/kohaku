import { describe, expect, it, vi } from "vitest";
import { createKeyedMutex } from "../src/keyed-mutex.js";

/** A deferred promise (lets a test control exactly when a queued fn resolves/rejects). */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createKeyedMutex", () => {
  it("serializes calls for the same key in arrival order", async () => {
    const lock = createKeyedMutex();
    const order: string[] = [];
    const first = deferred<void>();

    const p1 = lock("k", async () => {
      order.push("start-1");
      await first.promise;
      order.push("end-1");
    });
    // Queued before the first call resolves: must wait its turn, not run concurrently.
    const p2 = lock("k", async () => {
      order.push("start-2");
    });

    // Give the microtask queue a chance to run p1's body up to the await, but p2 must not have started yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start-1"]);

    first.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["start-1", "end-1", "start-2"]);
  });

  it("runs calls for different keys concurrently (no cross-key serialization)", async () => {
    const lock = createKeyedMutex();
    const order: string[] = [];
    const a = deferred<void>();

    const pA = lock("a", async () => {
      order.push("a-start");
      await a.promise;
      order.push("a-end");
    });
    const pB = lock("b", async () => {
      order.push("b-start");
      order.push("b-end");
    });

    // "b" (a different key) must be able to complete while "a" is still pending on its own key's chain.
    await pB;
    expect(order).toEqual(["a-start", "b-start", "b-end"]);

    a.resolve();
    await pA;
    expect(order).toEqual(["a-start", "b-start", "b-end", "a-end"]);
  });

  it("a rejection does not break the chain: subsequent calls for the same key still run", async () => {
    const lock = createKeyedMutex();
    const order: string[] = [];

    await expect(
      lock("k", async () => {
        order.push("first");
        throw new Error("first fails");
      }),
    ).rejects.toThrow("first fails");

    const result = await lock("k", async () => {
      order.push("second");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(order).toEqual(["first", "second"]);
  });

  it("removes its internal map entry once the queue for a key drains (no leak)", async () => {
    // createKeyedMutex's `locks` Map is closure-private (by design -- it is an implementation detail,
    // not part of the public KeyedMutex surface), so pin the "no leak" contract described in its
    // docstring ("if it is the tail of the chain ... it cleans up the entry to prevent leaks") by
    // spying on the real Map.prototype.delete it must call, rather than reaching into the closure.
    const deleteSpy = vi.spyOn(Map.prototype, "delete");
    try {
      const lock = createKeyedMutex();
      await lock("no-leak-key", async () => "done");
      // No successor was queued after this call, so the tail-cleanup branch must have fired.
      expect(deleteSpy).toHaveBeenCalledWith("no-leak-key");
    } finally {
      deleteSpy.mockRestore();
    }
  });

  it("does not substitute a different fn while a call for the same key is already waiting", async () => {
    const lock = createKeyedMutex();
    const order: string[] = [];
    const first = deferred<void>();

    const p1 = lock("k", async () => {
      order.push("first-start");
      await first.promise;
      order.push("first-end");
    });
    // Queue a second call with its own distinct fn while the first is still pending: it must run
    // (unchanged) once its turn comes, not be dropped or swapped for another queued fn.
    let secondRan = false;
    const p2 = lock("k", async () => {
      secondRan = true;
      order.push("second");
    });
    // A third call queued right after the second, for the same key, must run strictly after the second.
    const p3 = lock("k", async () => {
      order.push("third");
    });

    expect(secondRan).toBe(false);
    first.resolve();
    await Promise.all([p1, p2, p3]);
    expect(secondRan).toBe(true);
    expect(order).toEqual(["first-start", "first-end", "second", "third"]);
  });
});
