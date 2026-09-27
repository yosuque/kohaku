import type { ActionParamsSchema, DomainPort, OperationDescriptor } from "@kohaku-ui/spec-core";
import { assertValidActionParamsSchema } from "@kohaku-ui/spec-core";

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
}

/** A memoized, by-name index of a `DomainPort`'s operations. See `createOperationIndex`. */
export type OperationIndex = () => Promise<ReadonlyMap<string, OperationIndexEntry>>;

/**
 * Builds a memoizing `OperationIndex` closure for one `DomainPort` — built once per host attach / deps
 * object, mirroring `createAllowedActions`'s own memoization contract (`listOperations()` is async and
 * must not be re-awaited on every action invoke). Unlike `createAllowedActions` (which only needs the
 * *names* of a DomainPort's operations, for capability-scope filtering), this index keeps each
 * operation's full descriptor plus its params schema, already validated for keyword-subset compliance
 * (design.md #62) -- an operation whose `paramsSchema` uses a disallowed keyword throws
 * `ActionParamsSchemaError` here, at index-build time (attach time), rather than on the first request
 * that happens to invoke it.
 *
 * On rejection (either `listOperations()` itself failing, or a descriptor's schema failing validation)
 * the cached promise is discarded so the next call retries, and the rejection propagates to the caller
 * -- the same fail-fast-but-retryable contract as `createAllowedActions`. `onError` is a coarse,
 * observability-only fallback fired (fire-and-forget) on that same rejection.
 */
export function createOperationIndex(domain: DomainPort, onError?: (error: unknown) => void): OperationIndex {
  let cached: Promise<ReadonlyMap<string, OperationIndexEntry>> | undefined;
  return () => {
    if (cached == null) {
      const promise = domain.listOperations().then((ops) => {
        const index = new Map<string, OperationIndexEntry>();
        for (const op of ops) {
          const paramsSchema =
            op.paramsSchema != null ? assertValidActionParamsSchema(op.name, op.paramsSchema) : undefined;
          index.set(op.name, { descriptor: op, paramsSchema });
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
