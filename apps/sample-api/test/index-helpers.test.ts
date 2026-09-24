import { describe, expect, it, vi } from "vitest";
import {
  createShutdownHandler,
  schemaSuggestEnabled,
  schemaSuggestTimeoutMs,
  shutdownGraceMs,
  shutdownPrestopMs,
} from "../src/index.js";

// index.ts guards its own `main()` (env loading, a real LLM, the network listener, process.once) behind an
// `isMain` check (mirrors sample-mcp's src/http.ts), so importing it here for these pure/exported helpers
// has no side effects.

describe("shutdownGraceMs / shutdownPrestopMs (env parsing)", () => {
  it("defaults when unset", () => {
    expect(shutdownGraceMs({})).toBe(30_000);
    expect(shutdownPrestopMs({})).toBe(0);
  });
  it("parses a valid override", () => {
    expect(shutdownGraceMs({ KOHAKU_SHUTDOWN_GRACE_MS: "5000" })).toBe(5000);
    expect(shutdownPrestopMs({ KOHAKU_SHUTDOWN_PRESTOP_MS: "250" })).toBe(250);
  });
  it("falls back to the default for non-numeric / out-of-range values", () => {
    expect(shutdownGraceMs({ KOHAKU_SHUTDOWN_GRACE_MS: "not-a-number" })).toBe(30_000);
    expect(shutdownGraceMs({ KOHAKU_SHUTDOWN_GRACE_MS: "0" })).toBe(30_000);
    expect(shutdownPrestopMs({ KOHAKU_SHUTDOWN_PRESTOP_MS: "-5" })).toBe(0);
  });
});

describe("schemaSuggestEnabled / schemaSuggestTimeoutMs (KOHAKU_PROMOTION_SCHEMA_SUGGEST* kill switch)", () => {
  it("is enabled by default (unset)", () => {
    expect(schemaSuggestEnabled({})).toBe(true);
  });
  it("only the literal '0' disables it", () => {
    expect(schemaSuggestEnabled({ KOHAKU_PROMOTION_SCHEMA_SUGGEST: "0" })).toBe(false);
    expect(schemaSuggestEnabled({ KOHAKU_PROMOTION_SCHEMA_SUGGEST: "false" })).toBe(true);
    expect(schemaSuggestEnabled({ KOHAKU_PROMOTION_SCHEMA_SUGGEST: "1" })).toBe(true);
  });
  it("timeout defaults to 20000ms and parses an override", () => {
    expect(schemaSuggestTimeoutMs({})).toBe(20_000);
    expect(schemaSuggestTimeoutMs({ KOHAKU_PROMOTION_SCHEMA_SUGGEST_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(schemaSuggestTimeoutMs({ KOHAKU_PROMOTION_SCHEMA_SUGGEST_TIMEOUT_MS: "0" })).toBe(20_000);
  });
});

/** A fake server whose `close` callback fires only when `fireClose()` is called (simulates an in-flight drain). */
function fakeServer() {
  let closeCallback: (() => void) | undefined;
  let connectionsCallback: ((err: Error | null, count: number) => void) | undefined;
  return {
    closeIdleConnections: vi.fn(),
    close: vi.fn((cb: () => void) => {
      closeCallback = cb;
    }),
    getConnections: vi.fn((cb: (err: Error | null, count: number) => void) => {
      connectionsCallback = cb;
    }),
    fireClose: () => closeCallback?.(),
    fireGetConnections: (count: number) => connectionsCallback?.(null, count),
  };
}

describe("createShutdownHandler (graceful shutdown sequence)", () => {
  it("flips readiness and drains before closing storage: storage stays open until server.close's own callback fires", async () => {
    const server = fakeServer();
    const setShuttingDown = vi.fn();
    let portsClosed = false;
    const closePorts = vi.fn(async () => {
      portsClosed = true;
    });
    const exit = vi.fn();

    const handle = createShutdownHandler({
      server,
      setShuttingDown,
      closePorts,
      graceMs: 30_000,
      prestopMs: 0,
      log: () => {},
      exit,
    });
    handle("SIGTERM");
    // Readiness flips synchronously, ahead of any draining.
    expect(setShuttingDown).toHaveBeenCalledWith(true);
    // Wait for the prestop timer (0ms) to fire and reach server.close(...).
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.closeIdleConnections).toHaveBeenCalled();
    expect(server.close).toHaveBeenCalled();
    // The server has not yet invoked its own close callback: storage must still be untouched.
    expect(closePorts).not.toHaveBeenCalled();
    expect(portsClosed).toBe(false);
    expect(exit).not.toHaveBeenCalled();

    // Now the drain actually completes (the fake server's close callback fires).
    server.fireClose();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closePorts).toHaveBeenCalledTimes(1);
    expect(portsClosed).toBe(true);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("forced-exit path: also makes a best-effort attempt to close storage before exiting(1)", async () => {
    const server = fakeServer();
    const closePorts = vi.fn(async () => {});
    const exit = vi.fn();
    const handle = createShutdownHandler({
      server,
      setShuttingDown: vi.fn(),
      closePorts,
      graceMs: 5, // fires almost immediately so the test does not wait on the real drain path
      prestopMs: 0,
      log: () => {},
      exit,
    });
    handle("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The grace window elapsed before server.close's own callback fired (fireClose was never called).
    server.fireGetConnections(2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closePorts).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
