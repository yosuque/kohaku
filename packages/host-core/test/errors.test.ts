import { describe, expect, it, vi } from "vitest";
import { failOpen, notifyHook } from "../src/errors.js";

describe("notifyHook", () => {
  it("is a no-op when the hook is unwired", async () => {
    await expect(notifyHook(undefined, { x: 1 })).resolves.toBeUndefined();
  });

  it("calls the hook with info", async () => {
    const hook = vi.fn(async () => {});
    await notifyHook(hook, { endpoint: "compose", requestId: "r1", error: new Error("boom") });
    expect(hook).toHaveBeenCalledWith({ endpoint: "compose", requestId: "r1", error: expect.any(Error) });
  });

  it("swallows a synchronous throw from the hook", async () => {
    const hook = vi.fn(() => {
      throw new Error("hook broke");
    });
    await expect(notifyHook(hook, { x: 1 })).resolves.toBeUndefined();
  });

  it("swallows a rejected promise from the hook", async () => {
    const hook = vi.fn(async () => {
      throw new Error("hook rejected");
    });
    await expect(notifyHook(hook, { x: 1 })).resolves.toBeUndefined();
  });
});

describe("failOpen", () => {
  it("does not call onFailure when fn succeeds", async () => {
    const onFailure = vi.fn(async () => {});
    const fn = vi.fn(async () => {});
    await failOpen(fn, onFailure);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("calls onFailure with the thrown error and does not rethrow", async () => {
    const boom = new Error("record failed");
    const onFailure = vi.fn(async () => {});
    const fn = vi.fn(async () => {
      throw boom;
    });
    await expect(failOpen(fn, onFailure)).resolves.toBeUndefined();
    expect(onFailure).toHaveBeenCalledWith(boom);
  });

  it("propagates if onFailure itself throws (no double-swallowing at this layer)", async () => {
    const onFailure = vi.fn(async () => {
      throw new Error("onFailure broke");
    });
    const fn = vi.fn(async () => {
      throw new Error("original");
    });
    await expect(failOpen(fn, onFailure)).rejects.toThrow("onFailure broke");
  });
});
