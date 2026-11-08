"""Port of packages/spec-core/test/storage-conflict.test.ts, plus the PromotionState.revision cases of
persistence-schema.test.ts (validate_promotion_state)."""

from __future__ import annotations

from kohaku.spec import (
    GovernanceErrorDiscriminators,
    PromotionState,
    StorageConflictError,
    is_storage_conflict_error,
    validate_promotion_state,
)


def test_carries_the_discriminator_code_the_record_kind_and_the_key() -> None:
    e = StorageConflictError("promotion", "art-1")
    assert isinstance(e, Exception)
    assert e.code == "STORAGE_CONFLICT"
    assert e.code == GovernanceErrorDiscriminators.STORAGE_CONFLICT_CODE
    assert e.kind == "promotion"
    assert e.key == "art-1"
    assert str(e) == "storage conflict on promotion art-1"


def test_is_recognised_by_isinstance_and_by_the_duck_typed_name_and_code() -> None:
    assert is_storage_conflict_error(StorageConflictError("fixation", "h")) is True

    class StorageConflictError_(Exception):  # noqa: N801 -- same name via __name__ below
        code = "STORAGE_CONFLICT"

    foreign = type("StorageConflictError", (Exception,), {"code": "STORAGE_CONFLICT"})("x")
    assert is_storage_conflict_error(foreign) is True
    assert is_storage_conflict_error(StorageConflictError_("x")) is False
    assert is_storage_conflict_error("STORAGE_CONFLICT") is False


def test_validate_promotion_state_keeps_the_optional_revision() -> None:
    base = {
        "artifactId": "a1",
        "status": "candidate",
        "updatedAt": "2026-07-01T00:00:00Z",
        "data": {},
    }
    with_revision = validate_promotion_state({**base, "revision": "r1"})
    assert with_revision is not None and with_revision.revision == "r1"
    # A record that predates revision stays valid.
    legacy = validate_promotion_state(base)
    assert legacy == PromotionState(
        artifactId="a1", status="candidate", updatedAt="2026-07-01T00:00:00Z", data={}
    )
    # A non-string revision is rejected like any other malformed record.
    assert validate_promotion_state({**base, "revision": 3}) is None
