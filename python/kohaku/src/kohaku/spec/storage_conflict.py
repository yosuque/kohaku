"""Port of packages/spec-core/src/storage-conflict.ts: the error an optional-compare-and-set StoragePort raises."""

from __future__ import annotations

from typing import Literal


class StorageConflictError(Exception):
    """Raised by a `StoragePort` that declares `supports_compare_and_set` when a conditional write
    (`expected_revision` on `put_promotion_state` / `put_fixation` / `delete_fixation`) finds the stored
    record in a different state than the caller read: another writer (typically another host instance sharing
    the same backend) changed it in between. Nothing was written. The message names only the record kind and
    its key (an artifact id or an intent hash, never a payload), so it is safe to log; a host maps it to the
    fixed client-facing `CONFLICT` (HTTP 409) message instead of passing it through.

    `code` is the discriminator hosts match on structurally
    (`GovernanceErrorDiscriminators.STORAGE_CONFLICT_CODE`), so a duplicate import path still maps.
    """

    code = "STORAGE_CONFLICT"

    def __init__(self, kind: Literal["promotion", "fixation"], key: str) -> None:
        super().__init__(f"storage conflict on {kind} {key}")
        self.kind: Literal["promotion", "fixation"] = kind
        self.key = key


def is_storage_conflict_error(e: object) -> bool:
    """True for a `StorageConflictError`, matched by `isinstance` or, for a duplicate import path of this
    package, by class name + `code`."""
    if isinstance(e, StorageConflictError):
        return True
    return (
        isinstance(e, Exception)
        and type(e).__name__ == "StorageConflictError"
        and getattr(e, "code", None) == "STORAGE_CONFLICT"
    )
