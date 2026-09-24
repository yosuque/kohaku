import { describe, expect, it, vi } from "vitest";
import { buildShutdownHandler } from "../src/http.js";

/**
 * Thin smoke test: proves http.ts wires the shared graceful-shutdown handler
 * (@kohaku-ui-sample/api/app/shutdown) with the right `ports`/`label`, not a re-test of the handler's own
 * drain/close sequencing (covered once, for both entry points, by sample-api's own
 * test/shutdown-handler.test.ts).
 */
describe("buildShutdownHandler (sample-mcp's http.ts wiring of the shared handler)", () => {
  it("delegates to setup.close() once the (fake) server finishes draining", async () => {
    let closeCallback: (() => void) | undefined;
    const server = {
      closeIdleConnections: vi.fn(),
      close: vi.fn((cb: () => void) => {
        closeCallback = cb;
      }),
      getConnections: vi.fn(),
    };
    const setup = { close: vi.fn(async () => {}) };
    const exitCodes: number[] = [];
    const originalExit = process.exit;
    // buildShutdownHandler does not accept an injectable exit (it always builds a real handler for
    // production use), so this smoke test stubs process.exit for the one call the drain path makes.
    process.exit = ((code?: number) => {
      exitCodes.push(code ?? 0);
      return undefined as never;
    }) as typeof process.exit;
    try {
      const handle = buildShutdownHandler(server as never, setup);
      handle("SIGTERM");
      // The handler's own prestop wait defaults to 0 but is still scheduled via setTimeout (next tick).
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(server.close).toHaveBeenCalled();
      expect(setup.close).not.toHaveBeenCalled();
      closeCallback?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(setup.close).toHaveBeenCalledTimes(1);
      expect(exitCodes).toEqual([0]);
    } finally {
      process.exit = originalExit;
    }
  });
});
