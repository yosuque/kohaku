import { ComposeError, type ComposeErrorContext } from "@kohaku-ui/composer";
import { QueryRefError, SpecError } from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import {
  clientMessageFor,
  createConsoleErrorReporter,
  errorMessage,
  failOpen,
  formatErrorChain,
  isTypedHostError,
  notifyHook,
} from "../src/errors.js";

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

describe("formatErrorChain", () => {
  it("formats a single Error with no cause as one segment", () => {
    expect(formatErrorChain(new Error("boom"))).toBe("Error: boom");
  });

  it("walks the cause chain, joining with ' <- ' from immediate failure to root cause", () => {
    const root = new TypeError("network down");
    const middle = new Error("provider call failed", { cause: root });
    const top = new Error("compose failed", { cause: middle });
    expect(formatErrorChain(top)).toBe(
      "Error: compose failed <- Error: provider call failed <- TypeError: network down",
    );
  });

  it("stringifies a non-Error value (both as the top value and as a cause link)", () => {
    expect(formatErrorChain("just a string")).toBe("just a string");
    const withNonErrorCause = new Error("outer", { cause: "raw string cause" });
    expect(formatErrorChain(withNonErrorCause)).toBe("Error: outer <- raw string cause");
  });

  it("stops at maxDepth rather than looping forever on a circular cause chain", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b", { cause: a });
    a.cause = b; // a <- b <- a <- b <- ... (circular)
    const result = formatErrorChain(a, 4);
    expect(result.split(" <- ")).toHaveLength(4);
  });
});

describe("createConsoleErrorReporter", () => {
  function captureLines(): { lines: string[]; log: (line: string) => void } {
    const lines: string[] = [];
    return { lines, log: (line: string) => lines.push(line) };
  }

  it("debug:false (default) logs a one-line 'prefix: message' summary for the host hook", () => {
    const { lines, log } = captureLines();
    const reporter = createConsoleErrorReporter({ log });
    reporter.host({ endpoint: "/compose", requestId: "r1", error: new Error("boom") });
    expect(lines).toEqual(["[kohaku] /compose (request r1): boom"]);
  });

  it("mcp(): logs a one-line summary that carries no request id", () => {
    const { lines, log } = captureLines();
    const reporter = createConsoleErrorReporter({ log });
    reporter.mcp({ endpoint: "kohaku_compose", error: new Error("boom") });
    expect(lines).toEqual(["[kohaku] mcp kohaku_compose: boom"]);
  });

  it("debug:true logs the full cause chain and the stack trace, as separate lines", () => {
    const { lines, log } = captureLines();
    const reporter = createConsoleErrorReporter({ debug: true, log });
    const cause = new Error("root cause");
    const err = new Error("top failure", { cause });
    reporter.host({ endpoint: "/compose", requestId: "r1", error: err });

    expect(lines).toHaveLength(1);
    const [line] = lines as [string];
    expect(line).toContain("[kohaku] /compose (request r1): Error: top failure <- Error: root cause");
    expect(line).toContain(err.stack as string);
  });

  it("compose(): a fallback with no thrown error (error undefined) logs ctx.reason instead", () => {
    const { lines, log } = captureLines();
    const reporter = createConsoleErrorReporter({ log });
    const ctx: ComposeErrorContext = {
      phase: "fallback",
      input: { kind: "intent" },
      reason: "L1 constrained generation failed catalog/structure validation",
    };
    reporter.compose(ctx, undefined);
    expect(lines).toEqual([
      "[kohaku] compose fallback: L1 constrained generation failed catalog/structure validation",
    ]);
  });

  it("compose(): the correlation id, tier and intent are in the prefix when the context carries them", () => {
    const { lines, log } = captureLines();
    const reporter = createConsoleErrorReporter({ log });
    const ctx: ComposeErrorContext = {
      phase: "fallback",
      input: { kind: "intent" },
      tier: "L1",
      intent: { canonical: "sales.overview", params: {}, hash: "sha256:x" },
      correlationId: "req-42",
      reason: "generation failed",
    };
    reporter.compose(ctx, undefined);
    expect(lines).toEqual([
      "[kohaku] compose fallback (correlation req-42, tier L1, intent sales.overview): generation failed",
    ]);
  });

  it("compose(): a hard failure logs the thrown error", () => {
    const { lines, log } = captureLines();
    const reporter = createConsoleErrorReporter({ log });
    const ctx: ComposeErrorContext = { phase: "hard", input: { kind: "intent" } };
    reporter.compose(ctx, new Error("reference resolution failed"));
    expect(lines).toEqual(["[kohaku] compose hard: reference resolution failed"]);
  });

  it("defaults to console.error when log is not supplied", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reporter = createConsoleErrorReporter();
      reporter.host({ endpoint: "/compose", requestId: "r1", error: new Error("boom") });
      expect(spy).toHaveBeenCalledWith("[kohaku] /compose (request r1): boom");
    } finally {
      spy.mockRestore();
    }
  });
});
