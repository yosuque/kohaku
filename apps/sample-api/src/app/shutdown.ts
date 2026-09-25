/**
 * Shared graceful-shutdown machinery for the TS samples' network entry points: sample-api's `index.ts`
 * (REST) and sample-mcp's `http.ts` (Streamable HTTP). Both used to carry an independent, near-identical
 * copy of this handler; consolidated here so the shutdown-ordering fix (closing storage/authz only once
 * draining has actually finished — see `createGracefulShutdownHandler`'s own doc comment) exists, and is
 * tested, exactly once.
 *
 * Deliberately framework-free (no hono / host-rest import): depends only on a minimal server shape
 * (`close` / `getConnections` / an optional `closeIdleConnections`, satisfied by both `@hono/node-server`'s
 * `ServerType` and plain `node:http`'s `Server`) and a `{ close(): Promise<void> }` ports contract, so
 * sample-mcp's `http.ts` — which must not pull the REST framework into its import graph — can import this
 * via `@kohaku-ui-sample/api/app/shutdown` the same way it already imports `./ports/from-env`.
 */

/** Default drain window (ms) for graceful shutdown, overridable via KOHAKU_SHUTDOWN_GRACE_MS. */
const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

/** Parses KOHAKU_SHUTDOWN_GRACE_MS as a positive integer; any other value (unset, non-numeric, <= 0) falls back to the default. Shared by both entry points (same env var, same default). */
export function shutdownGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["KOHAKU_SHUTDOWN_GRACE_MS"];
  const parsed = raw != null ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SHUTDOWN_GRACE_MS;
}

/** Upper bound (ms) on the forced-exit path's own best-effort attempt to close the backends, so a hung close
 * can never delay the forced exit itself (which is already the point of that path). */
const FORCE_CLOSE_BOUND_MS = 2000;

/** The minimal server shape `createGracefulShutdownHandler` needs (a subset of `@hono/node-server`'s
 * `ServerType` / plain `node:http`'s `Server`, for testability with a fake). */
export interface GracefulShutdownServerLike {
  closeIdleConnections?: () => void;
  close: (callback: () => void) => void;
  getConnections: (callback: (err: Error | null, count: number) => void) => void;
}

/** The minimal ports shape this needs: whatever `createPortsFromEnv` / `createKohakuMcpSetup` return already
 * satisfies this structurally. */
export interface GracefulShutdownPorts {
  /** Closes the storage/authz backends this process created from env (a no-op unless KOHAKU_STORAGE is redis/postgres). */
  close(): Promise<void>;
}

export interface GracefulShutdownOptions {
  server: GracefulShutdownServerLike;
  ports: GracefulShutdownPorts;
  graceMs: number;
  /** Extra wait (ms) between flipping readiness (when `setShuttingDown` is given) and actually closing the
   * server. Default 0. Only sample-api's REST entry point has a readiness endpoint worth protecting this
   * way; sample-mcp's http.ts omits it (and `setShuttingDown`). */
  prestopMs?: number;
  /** Flips a readiness flag ahead of draining (sample-api's `GET /api/health`). Omitted for sample-mcp,
   * which has no readiness endpoint to flip (its own doc comment explains why). */
  setShuttingDown?: (value: boolean) => void;
  /** Log-message prefix identifying the process, e.g. "kohaku sample-api" / "kohaku-sales-sample MCP server". */
  label: string;
  log?: (message: string) => void;
  exit?: (code: number) => void;
}

/** Races `p` against a `ms`-bounded timer, so a slow-but-eventually-successful close can never hang the caller. */
function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return Promise.race([
    p,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the SIGINT/SIGTERM handler for graceful shutdown (ops): optionally flips readiness, optionally
 * waits a pre-stop window, drains connections, and only THEN closes the storage/authz backends
 * (`ports.close()`) — inside `server.close()`'s own callback, once draining has actually finished (closing
 * them earlier would let an in-flight request's storage call race the connection close). The forced-exit
 * path (the drain window elapsing first) also makes a best-effort, time-bounded (`FORCE_CLOSE_BOUND_MS`)
 * attempt to close them before exiting, rather than abandoning the close entirely.
 * Exported as a plain function of its dependencies (rather than only wired to `process.once`) so a test can
 * invoke it directly against a fake server / fake `ports` without sending a real OS signal or the process
 * actually exiting.
 */
export function createGracefulShutdownHandler(options: GracefulShutdownOptions): (signal: string) => void {
  const { server, ports, graceMs, setShuttingDown, label } = options;
  const prestopMs = options.prestopMs ?? 0;
  // stderr, not stdout: sample-mcp's stdio profile reserves stdout for the MCP JSON-RPC protocol itself
  // (its own index.ts logs "ready (stdio)" via console.error for the same reason), and this handler is
  // shared verbatim with sample-mcp's http.ts, so the default must not silently move its shutdown
  // messages onto stdout. Callers that do want stdout (or any other sink) still override via `log`.
  const log = options.log ?? ((message: string) => console.error(message));
  const exit = options.exit ?? process.exit.bind(process);
  return (signal: string) => {
    setShuttingDown?.(true);
    let message = `${label}: received ${signal}`;
    if (setShuttingDown != null) message += ", marked not-ready";
    if (prestopMs > 0) message += ` (pre-stop wait ${prestopMs}ms)`;
    message += `, then draining connections (grace ${graceMs}ms)`;
    log(message);
    const prestopTimer = setTimeout(() => {
      // Close idle keep-alive sockets immediately rather than waiting for their keep-alive timeout to
      // elapse: server.close() alone only stops accepting *new* connections and waits for every existing
      // one (idle or not) to end before its callback fires, so an idle client sitting on a keep-alive
      // connection would otherwise stall the drain for no reason.
      server.closeIdleConnections?.();
      // Started before server.close() itself, and explicitly cleared in its callback below: a clean
      // drain that finishes before graceMs elapses must not leave this timer pending, or the forced-exit
      // branch would still fire later (calling ports.close() a second time and exit(1) after exit(0)
      // already ran).
      const graceTimer = setTimeout(() => {
        server.getConnections((err, count) => {
          log(
            `${label}: shutdown grace period (${graceMs}ms) elapsed with ` +
              `${err != null ? "an unknown number of" : count} connection(s) still open; forcing exit`,
          );
          // Best-effort, bounded: we are exiting regardless, but a close that succeeds quickly is still
          // better than abandoning it outright. Logged (not swallowed) so a failing close is observable,
          // while still never blocking or delaying the exit itself.
          void withTimeout(
            ports.close().catch((error: unknown) => {
              log(
                `${label}: failed to close storage/authz backends before forced exit: ${errorMessage(error)}`,
              );
            }),
            FORCE_CLOSE_BOUND_MS,
          ).then(() => exit(1));
        });
      }, graceMs);
      graceTimer.unref?.();
      server.close(() => {
        // The drain has actually completed at this point (no in-flight request can still be running):
        // only now is it safe to close the storage/authz backends those requests might have been using.
        // Clear the forced-exit timer first so a clean drain can never also trigger it.
        clearTimeout(graceTimer);
        void ports
          .close()
          .catch((error: unknown) => {
            log(
              `${label}: failed to close storage/authz backends after a clean drain: ${errorMessage(error)}`,
            );
          })
          .then(() => exit(0));
      });
    }, prestopMs);
    prestopTimer.unref?.();
  };
}
