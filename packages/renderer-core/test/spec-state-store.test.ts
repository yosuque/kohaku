import { describe, expect, it, vi } from "vitest";
import { createSpecStateStore } from "../src/index.js";

describe("createSpecStateStore", () => {
  it("holds initial values and reads them via get / values", () => {
    const store = createSpecStateStore("h1", { region: "japan" });
    expect(store.get("region")).toBe("japan");
    expect(store.values).toEqual({ region: "japan" });
    expect(store.get("missing")).toBeUndefined();
  });

  it("set updates the value and notifies subscribers; the values reference is replaced", () => {
    const store = createSpecStateStore("h1", {});
    const cb = vi.fn();
    store.subscribe(cb);
    const before = store.values;
    store.set("region", "us");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(store.get("region")).toBe("us");
    // like React's setValues({...prev}), it becomes a new object reference
    expect(store.values).not.toBe(before);
  });

  it("no notification after unsubscribe", () => {
    const store = createSpecStateStore("h1", {});
    const cb = vi.fn();
    const unsub = store.subscribe(cb);
    unsub();
    store.set("x", 1);
    expect(cb).not.toHaveBeenCalled();
  });

  it("resetForIntent is a no-op on the same hash (keeps values)", () => {
    const store = createSpecStateStore("h1", { region: "japan" });
    const cb = vi.fn();
    store.subscribe(cb);
    store.set("region", "us");
    store.resetForIntent("h1", { region: "japan" });
    // hash unchanged → not reset, stays "us", and no notification fires (only the single set)
    expect(store.get("region")).toBe("us");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("resetForIntent re-initializes to the new initialState on hash change and notifies", () => {
    const store = createSpecStateStore("h1", { region: "japan" });
    const cb = vi.fn();
    store.subscribe(cb);
    store.set("region", "us");
    store.resetForIntent("h2", { region: "germany" });
    expect(store.get("region")).toBe("germany");
    expect(cb).toHaveBeenCalledTimes(2); // set + reset
  });
});
