import type { ActionParamsSchema, DomainPort, OperationDescriptor } from "@kohaku-ui/spec-core";
import { ActionParamsSchemaError, assertValidActionParamsSchema } from "@kohaku-ui/spec-core";

/** One `DomainPort` operation, indexed by name, with its `paramsSchema` (if any) pre-validated. */
export interface OperationIndexEntry {
  descriptor: OperationDescriptor;
  /**
   * The descriptor's `paramsSchema`, already checked against kohaku's closed JSON Schema subset
   * (design.md #62) — `undefined` when the descriptor declared none (an action with no schema accepts
   * any payload). Consumers (`createActionGate`) validate a request's payload against this without
   * re-checking the schema's own shape on every call.
   */
  paramsSchema?: ActionParamsSchema;
  /**
   * Set (and `paramsSchema` left undefined) when the descriptor's `paramsSchema` uses a keyword outside the
   * closed subset. The operation stays in the index -- its name is still a declared operation, so capability
   * scopes and the undeclared-action check are unaffected -- but it must never be invoked: a consumer that
   * gates an invoke fails closed on this entry (REST: 500, MCP: a tool error), and the actions manifest omits
   * it. One bad schema therefore breaks only its own operation.
   */
  schemaError?: ActionParamsSchemaError;
}

/** A memoized, by-name index of a `DomainPort`'s operations. See `createOperationIndex`. */
export type OperationIndex = () => Promise<ReadonlyMap<string, OperationIndexEntry>>;

/**
 * Builds a memoizing `OperationIndex` closure for one `DomainPort` — built once per host attach / deps
 * object, mirroring `createAllowedActions`'s own memoization contract (`listOperations()` is async and
 * must not be re-awaited on every action invoke). Unlike `createAllowedActions` (which only needs the
 * *names* of a DomainPort's operations, for capability-scope filtering), this index keeps each
 * operation's full descriptor plus its params schema, already validated for keyword-subset compliance
 * (design.md #62). An operation whose `paramsSchema` uses a disallowed keyword does not fail the whole
 * index: it is kept with `schemaError` set (see `OperationIndexEntry`), so the failure is confined to that
 * operation, and `validateOperationIndex` reports it at attach time rather than on the first request that
 * happens to invoke it.
 *
 * On rejection (`listOperations()` itself failing) the cached promise is discarded so the next call
 * retries, and the rejection propagates to the caller -- the same fail-fast-but-retryable contract as
 * `createAllowedActions`. `onError` is a coarse,
 * observability-only fallback fired (fire-and-forget) on that same rejection.
 */
export function createOperationIndex(domain: DomainPort, onError?: (error: unknown) => void): OperationIndex {
  let cached: Promise<ReadonlyMap<string, OperationIndexEntry>> | undefined;
  return () => {
    if (cached == null) {
      const promise = domain.listOperations().then((ops) => {
        const index = new Map<string, OperationIndexEntry>();
        for (const op of ops) {
          try {
            const paramsSchema =
              op.paramsSchema != null ? assertValidActionParamsSchema(op.name, op.paramsSchema) : undefined;
            index.set(op.name, { descriptor: op, paramsSchema });
          } catch (e) {
            if (!(e instanceof ActionParamsSchemaError)) throw e;
            index.set(op.name, { descriptor: op, schemaError: e });
          }
        }
        return index;
      });
      promise.catch((e) => {
        if (cached === promise) cached = undefined;
        onError?.(e);
      });
      cached = promise;
    }
    return cached;
  };
}

/**
 * Builds `index` now and reports every problem it finds through `report` (which must not reject): the
 * index failing to build at all (`listOperations()` rejecting), and each operation whose `paramsSchema` is
 * outside the closed subset (`OperationIndexEntry.schemaError`). Both host attach functions are synchronous
 * while `listOperations()` is async, so they call this without awaiting it, to surface a schema author's
 * typo at startup rather than at the first request that hits it. Never rejects.
 */
export async function validateOperationIndex(
  index: OperationIndex,
  report: (error: unknown) => void | Promise<void>,
): Promise<void> {
  try {
    for (const entry of (await index()).values()) {
      if (entry.schemaError != null) await report(entry.schemaError);
    }
  } catch (e) {
    await report(e);
  }
}
