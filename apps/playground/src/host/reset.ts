import type { ReplayFixtures } from "@kohaku-ui/evals/replay";
import type { SampleApp } from "@kohaku-ui-sample/api/browser";
import { createPlaygroundHost } from "./create-host.js";

/**
 * localStorage keys the playground's UI (`PlaygroundBar`, u5-2 task 6) persists the selected demo role /
 * tenant under. Defined here — not in the UI module — so `reset()` can clear them without depending on the
 * UI layer, and so the UI module imports the same two constants instead of re-typing the strings.
 */
export const ROLE_STORAGE_KEY = "kohaku-playground:role";
export const TENANT_STORAGE_KEY = "kohaku-playground:tenant";

export interface PlaygroundHostHandle {
  /**
   * The current host. `reset()` replaces this wholesale (a new `SampleApp`, backed by new in-memory
   * storage) — always call this getter fresh rather than caching its result, exactly the way
   * `fetch-shim.ts`'s `installFetchShim` does.
   */
  getHost(): SampleApp;
  /**
   * Rebuilds the host from scratch (fresh in-memory `StoragePort` → empty lineage/promotions/fixations,
   * fresh `SalesRepo` instance → `notes`/`bumpCount` back to their initial state) and clears the persisted
   * role/tenant selection, so the playground returns to exactly its first-load state. A `fetch` shim
   * installed via `installFetchShim(() => handle.getHost())` picks up the new host on its very next call —
   * no reinstall needed.
   */
  reset(): Promise<void>;
}

/**
 * Builds the first host and returns a handle that can rebuild it on demand. `fixtures` is forwarded to
 * every `createPlaygroundHost()` call (including the ones `reset()` makes), so a fixed fixture set stays in
 * effect across a reset.
 */
export async function createPlaygroundHostHandle(fixtures?: ReplayFixtures): Promise<PlaygroundHostHandle> {
  let current = await createPlaygroundHost(fixtures);
  return {
    getHost: () => current,
    reset: async () => {
      current = await createPlaygroundHost(fixtures);
      try {
        globalThis.localStorage?.removeItem(ROLE_STORAGE_KEY);
        globalThis.localStorage?.removeItem(TENANT_STORAGE_KEY);
      } catch {
        // localStorage can throw (private browsing, blocked site data, a non-browser test environment
        // with no localStorage at all) — the host itself is already the new one at this point, so reset()
        // still succeeds; only the persisted role/tenant selection fails to also clear.
      }
    },
  };
}
