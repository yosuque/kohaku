import { describe, expect, it, vi } from "vitest";
import { createGracefulShutdownHandler, shutdownGraceMs } from "../src/app/shutdown.js";

// The single test suite for the graceful-shutdown machinery shared between sample-api's own index.ts and
// sample-mcp's http.ts (@kohaku-ui-sample/api/app/shutdown) — see that module's own doc comment. Both entry
// points used to carry a near-identical copy of this sequence with its own fakeServer() test helper; this
// file (and the one `fakeServer()` below) now covers it once for both.

describe("shutdownGraceMs (env parsing, shared by both entry points)", () => {
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

describe("createGracefulShutdownHandler: with setShuttingDown + prestopMs (sample-api's own shape)", () => {
  it("flips readiness and drains before closing storage: storage stays open until server.close's own callback fires", async () => {
    const server = fakeServer();
    const setShuttingDown = vi.fn();
    let portsClosed = false;
    const ports = {
      close: vi.fn(async () => {
        portsClosed = true;
      }),
    };
    const exit = vi.fn();

    const handle = createGracefulShutdownHandler({
      server,
      ports,
      setShuttingDown,
      graceMs: 30_000,
      prestopMs: 0,
      label: "test",
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
    expect(ports.close).not.toHaveBeenCalled();
    expect(portsClosed).toBe(false);
    expect(exit).not.toHaveBeenCalled();

    // Now the drain actually completes (the fake server's close callback fires).
    server.fireClose();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ports.close).toHaveBeenCalledTimes(1);
    expect(portsClosed).toBe(true);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("forced-exit path: also makes a best-effort attempt to close storage before exiting(1)", async () => {
    const server = fakeServer();
    const ports = { close: vi.fn(async () => {}) };
    const exit = vi.fn();
    const handle = createGracefulShutdownHandler({
      server,
      ports,
      setShuttingDown: vi.fn(),
      graceMs: 5, // fires almost immediately so the test does not wait on the real drain path
      prestopMs: 0,
      label: "test",
      log: () => {},
      exit,
    });
    handle("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The grace window elapsed before server.close's own callback fired (fireClose was never called).
    server.fireGetConnections(2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ports.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("createGracefulShutdownHandler: without setShuttingDown/prestopMs (sample-mcp's shape)", () => {
  it("drains (with no readiness flag to flip) before closing storage, same ordering guarantee", async () => {
    const server = fakeServer();
    let portsClosed = false;
    const ports = {
      close: vi.fn(async () => {
        portsClosed = true;
      }),
    };
    const exit = vi.fn();

    const handle = createGracefulShutdownHandler({
      server,
      ports,
      graceMs: 30_000,
      label: "test-mcp",
      log: () => {},
      exit,
    });
    handle("SIGTERM");
    // prestopMs defaults to 0 but is still scheduled via setTimeout (next tick), not synchronous.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.closeIdleConnections).toHaveBeenCalled();
    expect(server.close).toHaveBeenCalled();
    expect(ports.close).not.toHaveBeenCalled();
    expect(portsClosed).toBe(false);

    server.fireClose();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ports.close).toHaveBeenCalledTimes(1);
    expect(portsClosed).toBe(true);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("forced-exit path: also makes a best-effort attempt to close storage before exiting(1)", async () => {
    const server = fakeServer();
    const ports = { close: vi.fn(async () => {}) };
    const exit = vi.fn();
    const handle = createGracefulShutdownHandler({
      server,
      ports,
      graceMs: 5,
      label: "test-mcp",
      log: () => {},
      exit,
    });
    handle("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 15));
    server.fireGetConnections(3);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ports.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
