/**
 * Thrown by a `StoragePort` that declares `supportsCompareAndSet` when a conditional write
 * (`expectedRevision` on `putPromotionState` / `putFixation` / `deleteFixation`) finds the stored record in a
 * different state than the caller read: another writer (typically another host instance sharing the same
 * backend) changed it in between. Nothing was written. The message names only the record kind and its key
 * (an artifact id or an intent hash, never a payload), so it is safe to log; a host maps it to the fixed
 * client-facing `CONFLICT` (HTTP 409) message instead of passing it through.
 *
 * `code` is the discriminator hosts match on structurally (spec-core's
 * `GOVERNANCE_ERROR_DISCRIMINATORS.storageConflictCode`), so a duplicate install of this package still maps.
 */
export class StorageConflictError extends Error {
  readonly code = "STORAGE_CONFLICT";

  constructor(
    readonly kind: "promotion" | "fixation",
    readonly key: string,
  ) {
    super(`storage conflict on ${kind} ${key}`);
    this.name = "StorageConflictError";
  }
}

/**
 * True for a {@link StorageConflictError}, matched by `instanceof` or, for a duplicate install of this
 * package, by `name` + `code`.
 */
export function isStorageConflictError(e: unknown): e is StorageConflictError {
  return (
    e instanceof StorageConflictError ||
    (e instanceof Error &&
      e.name === "StorageConflictError" &&
      (e as { code?: unknown }).code === "STORAGE_CONFLICT")
  );
}
