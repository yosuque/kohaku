/** The lock function returned by createKeyedMutex (executes fn for the same key serially in arrival order). */
export type KeyedMutex = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

/**
 * Builds a simple per-key mutex. A Promise chain orders processing for the same key by arrival. Regardless of
 * the previous stage's success/failure, it only waits for its turn and then runs its own processing (does not
 * get dragged down by the previous stage's failure). After completion, if it is the tail of the chain (no
 * successor has been queued), it cleans up the entry to prevent leaks (if there is a successor, it has already
 * been replaced, so it is left untouched).
 *
 * Shared by every in-process (tenant, key) / (tenant, artifactId) / file-path serialization site across the
 * reference implementation: host-rest's promotion lock and fixation lock (`withFixationLock`), the sample
 * storage port's per-snapshot-file lock, and host-mcp-apps's fixation self-heal serialization (keyed by
 * `intentHash` alone, since the MCP profile never resolves a tenant). It only orders calls made *within this
 * process*; see `StoragePort`'s docstring (spec-core) for the cross-process concurrency contract this
 * mechanism sits on top of.
 */
export function createKeyedMutex(): KeyedMutex {
  const locks = new Map<string, Promise<void>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    // The tail Promise used to gate the next stage (always resolves; never rejects).
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    locks.set(key, tail);
    try {
      return await result;
    } finally {
      if (locks.get(key) === tail) locks.delete(key);
    }
  };
}
