import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGracefulShutdownHandler, shutdownGraceMs } from "../src/app/shutdown.js";

// The single test suite for the graceful-shutdown machinery shared between sample-api's own index.ts and
// sample-mcp's http.ts (@kohaku-ui-sample/api/app/shutdown) — see that module's own doc comment. Both entry
// points used to carry a near-identical copy of this sequence with its own fakeServer() test helper; this
// file (and the one `fakeServer()` below) now covers it once for both.

// Fake timers throughout: the handler only registers its grace timer from inside the prestop timer's own
// callback, so real-time waits raced a busy CI event loop (the grace timer could still be unregistered when a
// fixed 10ms sleep ended). advanceTimersByTimeAsync runs every due timer and settles the promise chains
// between them, deterministically.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

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
    await vi.advanceTimersByTimeAsync(10);
    expect(server.closeIdleConnections).toHaveBeenCalled();
    expect(server.close).toHaveBeenCalled();
    // The server has not yet invoked its own close callback: storage must still be untouched.
    expect(ports.close).not.toHaveBeenCalled();
    expect(portsClosed).toBe(false);
    expect(exit).not.toHaveBeenCalled();

    // Now the drain actually completes (the fake server's close callback fires).
    server.fireClose();
    await vi.advanceTimersByTimeAsync(10);
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
    await vi.advanceTimersByTimeAsync(20);
    // The grace window elapsed before server.close's own callback fired (fireClose was never called).
    server.fireGetConnections(2);
    await vi.advanceTimersByTimeAsync(10);
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
    await vi.advanceTimersByTimeAsync(10);
    expect(server.closeIdleConnections).toHaveBeenCalled();
    expect(server.close).toHaveBeenCalled();
    expect(ports.close).not.toHaveBeenCalled();
    expect(portsClosed).toBe(false);

    server.fireClose();
    await vi.advanceTimersByTimeAsync(10);
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
    await vi.advanceTimersByTimeAsync(15);
    server.fireGetConnections(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(ports.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("createGracefulShutdownHandler: grace-timer cleanup and log routing", () => {
  it("a clean drain clears the grace timer, so the forced-exit branch never runs afterwards", async () => {
    const server = fakeServer();
    const ports = { close: vi.fn(async () => {}) };
    const exit = vi.fn();
    const handle = createGracefulShutdownHandler({
      server,
      ports,
      graceMs: 10,
      label: "test",
      log: () => {},
      exit,
    });
    handle("SIGTERM");
    // prestopMs defaults to 0 but server.close() is only reached once that timer's callback actually
    // runs (next tick, not synchronous) -- wait for it before the drain can complete.
    await vi.advanceTimersByTimeAsync(2);
    // The drain completes well within the (10ms) grace window.
    server.fireClose();
    await vi.advanceTimersByTimeAsync(5);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    // Wait past the grace window: if the timer were not cleared, getConnections/exit(1) would fire here.
    await vi.advanceTimersByTimeAsync(20);
    expect(server.getConnections).not.toHaveBeenCalled();
    expect(ports.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("the forced-exit message is routed through the injected log, not a bare console.error", async () => {
    const server = fakeServer();
    const ports = { close: vi.fn(async () => {}) };
    const log = vi.fn();
    const handle = createGracefulShutdownHandler({
      server,
      ports,
      graceMs: 5,
      label: "test-label",
      log,
      exit: vi.fn(),
    });
    handle("SIGINT");
    await vi.advanceTimersByTimeAsync(10);
    server.fireGetConnections(4);
    await vi.advanceTimersByTimeAsync(10);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "test-label: shutdown grace period (5ms) elapsed with 4 connection(s) still open; forcing exit",
      ),
    );
  });

  it("a close failure after a clean drain is logged (not silently swallowed), and shutdown still completes", async () => {
    const server = fakeServer();
    const closeError = new Error("boom: clean-drain close failed");
    const ports = { close: vi.fn(async () => Promise.reject(closeError)) };
    const log = vi.fn();
    const exit = vi.fn();
    const handle = createGracefulShutdownHandler({
      server,
      ports,
      graceMs: 30_000,
      label: "test-label",
      log,
      exit,
    });
    handle("SIGTERM");
    // prestopMs defaults to 0 but server.close() is only reached on the next tick (see the timer-cleanup
    // test above for the full explanation).
    await vi.advanceTimersByTimeAsync(2);
    server.fireClose();
    await vi.advanceTimersByTimeAsync(10);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "test-label: failed to close storage/authz backends after a clean drain: boom: clean-drain close failed",
      ),
    );
    // Non-blocking: exit still happens despite the close failure.
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("a close failure on the forced-exit path is logged too, and the forced exit still completes", async () => {
    const server = fakeServer();
    const closeError = new Error("boom: forced-exit close failed");
    const ports = { close: vi.fn(async () => Promise.reject(closeError)) };
    const log = vi.fn();
    const exit = vi.fn();
    const handle = createGracefulShutdownHandler({
      server,
      ports,
      graceMs: 5,
      label: "test-label",
      log,
      exit,
    });
    handle("SIGINT");
    await vi.advanceTimersByTimeAsync(10);
    server.fireGetConnections(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "test-label: failed to close storage/authz backends before forced exit: boom: forced-exit close failed",
      ),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("with no `log` override, the default writes to stderr (console.error), not stdout (console.log)", async () => {
    // Regression guard: sample-mcp's stdio profile reserves stdout for the MCP JSON-RPC protocol itself,
    // so this shared handler's default must never write shutdown messages to stdout -- both call sites
    // (sample-api's index.ts, sample-mcp's http.ts) rely on this default rather than passing their own `log`.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const server = fakeServer();
      const ports = { close: vi.fn(async () => {}) };
      const handle = createGracefulShutdownHandler({
        server,
        ports,
        graceMs: 30_000,
        label: "test-stderr",
        exit: vi.fn(),
      });
      handle("SIGTERM");
      await vi.advanceTimersByTimeAsync(2);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("test-stderr: received SIGTERM"));
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
