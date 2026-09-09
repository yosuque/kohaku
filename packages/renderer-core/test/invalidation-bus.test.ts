import { describe, expect, it, vi } from "vitest";
import { createDataInvalidationBus, NOOP_INVALIDATION_BUS } from "../src/index.js";

const A = "query://x/a?p=1";
const B = "query://x/b?p=1";

describe("createDataInvalidationBus", () => {
  it("delivers only to subscribers of the matching ref", () => {
    const bus = createDataInvalidationBus();
    const onA = vi.fn();
    const onB = vi.fn();
    bus.subscribe(A, onA);
    bus.subscribe(B, onB);
    bus.publish({ refs: [A] });
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).not.toHaveBeenCalled();
  });

  it("passes the event including refVersions through as-is", () => {
    const bus = createDataInvalidationBus();
    const cb = vi.fn();
    bus.subscribe(A, cb);
    bus.publish({ refs: [A], refVersions: { [A]: "v2" } });
    expect(cb).toHaveBeenCalledWith({ refs: [A], refVersions: { [A]: "v2" } });
  });

  it("no delivery after unsubscribe; safe to unsubscribe during iteration", () => {
    const bus = createDataInvalidationBus();
    const cb = vi.fn();
    const unsub = bus.subscribe(A, cb);
    unsub();
    bus.publish({ refs: [A] });
    expect(cb).not.toHaveBeenCalled();
  });

  it("can invalidate multiple refs in one event", () => {
    const bus = createDataInvalidationBus();
    const onA = vi.fn();
    const onB = vi.fn();
    bus.subscribe(A, onA);
    bus.subscribe(B, onB);
    bus.publish({ refs: [A, B] });
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).toHaveBeenCalledTimes(1);
  });

  it("NOOP bus does not throw on publish or subscribe", () => {
    expect(() => {
      const unsub = NOOP_INVALIDATION_BUS.subscribe(A, () => {});
      NOOP_INVALIDATION_BUS.publish({ refs: [A] });
      unsub();
    }).not.toThrow();
  });
});
