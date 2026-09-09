import { createKeyedMutex, type KeyedMutex } from "@kohaku-ui/host-core";
import type { KohakuHostDeps } from "./types.js";

// createKeyedMutex / KeyedMutex now live in host-core (the single implementation shared with the sample
// storage port and host-mcp-apps's fixation self-heal serialization; see host-core/src/keyed-mutex.ts for the
// doc comment). Re-exported here for backward compatibility with existing importers of this module.
export { createKeyedMutex, type KeyedMutex };

/**
 * A simple mutex that serializes the fixation's read-modify-write (self-healing's refreshFingerprint / invalidate
 * and the management plane's fixate / unfixate) per (tenant, intentHash) within the process (the same per-tenant
 * serialization strategy as the promotion lock).
 * Self-healing fires fire-and-forget from the compose path, so without serialization interleavings such as
 * "refreshFingerprint's get->put right after unfixate resurrects a deleted fixation" occur.
 * The lock is scoped per deps (= host instance) (in-process only; cross-process serialization is delegated to the
 * StoragePort's single-writer assumption).
 */
const fixationMutexByDeps = new WeakMap<KohakuHostDeps, KeyedMutex>();
export function withFixationLock<T>(
  deps: KohakuHostDeps,
  tenant: string | undefined,
  intentHash: string,
  fn: () => Promise<T>,
): Promise<T> {
  let mutex = fixationMutexByDeps.get(deps);
  if (mutex == null) {
    mutex = createKeyedMutex();
    fixationMutexByDeps.set(deps, mutex);
  }
  return mutex(`${tenant ?? ""} ${intentHash}`, fn);
}
