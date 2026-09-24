import { describe, expect, it, vi } from "vitest";
import { createShutdownHandler, shutdownGraceMs } from "../src/http.js";

// http.ts guards its own `main()` (env loading, listening, process.once) behind an `isMain` check, so
// importing it here for these pure/exported helpers has no side effects (mirrors sample-api's own
// index-helpers.test.ts, which covers the parallel finding on the REST entry point).

describe("shutdownGraceMs (env parsing)", () => {
  it("defaults when unset", () => {
    expect(shutdownGraceMs({})).toBe(30_000);
  });
  it("parses a valid override and falls back for non-numeric / out-of-range values", () => {
    expect(shutdownGraceMs({ KOHAKU_SHUTDOWN_GRACE_MS: "5000" })).toBe(5000);
    expect(shutdownGraceMs({ KOHAKU_SHUTDOWN_GRACE_MS: "not-a-number" })).toBe(30_000);
    expect(shutdownGraceMs({ KOHAKU_SHUTDOWN_GRACE_MS: "0" })).toBe(30_000);
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

describe("createShutdownHandler (sample-mcp's Streamable HTTP graceful shutdown)", () => {
  it("drains before closing storage: storage stays open until server.close's own callback fires", async () => {
    const server = fakeServer();
    let portsClosed = false;
    const closePorts = vi.fn(async () => {
      portsClosed = true;
    });
    const exit = vi.fn();

    const handle = createShutdownHandler({ server, closePorts, graceMs: 30_000, log: () => {}, exit });
    handle("SIGTERM");
    expect(server.closeIdleConnections).toHaveBeenCalled();
    expect(server.close).toHaveBeenCalled();
    // The server has not yet invoked its own close callback: storage must still be untouched.
    expect(closePorts).not.toHaveBeenCalled();
    expect(portsClosed).toBe(false);
    expect(exit).not.toHaveBeenCalled();

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
    const handle = createShutdownHandler({ server, closePorts, graceMs: 5, log: () => {}, exit });
    handle("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 15));
    // The grace window elapsed before server.close's own callback fired (fireClose was never called).
    server.fireGetConnections(3);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closePorts).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
