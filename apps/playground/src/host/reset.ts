import type { ReplayFixtures } from "@kohaku-ui/evals/replay";
import type { SampleApp } from "@kohaku-ui-sample/api/browser";
import { setRole, setTenant } from "@kohaku-ui-sample/web/app";
import { createPlaygroundHost } from "./create-host.js";

export interface PlaygroundHostHandle {
  /**
   * The current host. `reset()` replaces this wholesale (a new `SampleApp`, backed by new in-memory
   * storage) — always call this getter fresh rather than caching its result, exactly the way
   * `fetch-shim.ts`'s `installFetchShim` does.
   */
  getHost(): SampleApp;
  /**
   * Rebuilds the host from scratch (fresh in-memory `StoragePort` → empty lineage/promotions/fixations,
   * fresh `SalesRepo` instance → `notes`/`bumpCount` back to their initial state) and returns the demo role
   * / tenant selectors to their defaults, so the playground returns to exactly its first-load state. A
   * `fetch` shim installed via `installFetchShim(() => handle.getHost())` picks up the new host on its very
   * next call — no reinstall needed.
   *
   * Role/tenant reset goes through sample-web's own `setRole("admin")`/`setTenant("default")` (its `./app`
   * export — see `entry.ts`'s doc comment), not a guessed localStorage key: `role.ts`/`tenant.ts` keep a
   * module-level `current` value that a header selector's `useRole`/`useTenant` hook is subscribed to, so
   * clearing localStorage directly would leave an already-rendered selector showing the stale choice until
   * a full page reload. Calling the real setters updates `current`, persists it, and notifies every
   * subscriber immediately — exactly like a user picking "admin"/"default" from the selector themselves.
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
      setRole("admin");
      setTenant("default");
    },
  };
}
