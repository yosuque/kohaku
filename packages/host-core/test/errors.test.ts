import { ComposeError } from "@kohaku-ui/composer";
import { QueryRefError, SpecError } from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import { clientMessageFor, errorMessage, failOpen, isTypedHostError, notifyHook } from "../src/errors.js";

describe("errorMessage", () => {
  it("returns the message of an Error", () => {
    expect(errorMessage(new Error("x"))).toBe("x");
  });

  it("returns a non-Error value as-is (a string passes through unchanged)", () => {
    expect(errorMessage("y")).toBe("y");
  });

  it("stringifies an arbitrary non-Error value", () => {
    expect(errorMessage({})).toBe("[object Object]");
  });
});

describe("isTypedHostError", () => {
  it("is true for a SpecError", () => {
    expect(isTypedHostError(new SpecError("PARSE_FAILED", "bad spec"))).toBe(true);
  });

  it("is true for a ComposeError", () => {
    expect(isTypedHostError(new ComposeError("INTERNAL", "compose blew up"))).toBe(true);
  });

  it("is true for a QueryRefError", () => {
    expect(isTypedHostError(new QueryRefError("query://x/y", "bad ref"))).toBe(true);
  });

  it("is true for a plain Error carrying a string `code` property", () => {
    const e = Object.assign(new Error("governance failed"), { code: "PROMOTION_NOT_PUBLISHED" });
    expect(isTypedHostError(e)).toBe(true);
  });

  it("is false for a plain Error with no `code` property", () => {
    expect(isTypedHostError(new Error("boom"))).toBe(false);
  });

  it("is false for a non-Error value", () => {
    expect(isTypedHostError("boom")).toBe(false);
  });
});

describe("clientMessageFor", () => {
  it("returns the error's own message for a typed host error", () => {
    const e = new SpecError("STRUCTURE_INVALID", "the spec is missing a root component");
    expect(clientMessageFor(e, "fb")).toBe("the spec is missing a root component");
  });

  it("returns the fallback for an untyped Error (does not leak its message)", () => {
    expect(clientMessageFor(new Error("secret"), "fb")).toBe("fb");
  });

  it("returns the fallback for a non-Error value", () => {
    expect(clientMessageFor("secret", "fb")).toBe("fb");
  });
});

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
