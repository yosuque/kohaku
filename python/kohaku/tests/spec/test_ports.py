"""Pins the real detection semantics of `SupportsBatchPromotionStates` (Important #2 of the
2026-09-20 final review of refactor/review-c-python): `isinstance(storage, SupportsBatchPromotionStates)`
is NOT the same presence-only check as the old `getattr(storage, "put_promotion_states", None)` probe it
replaced. See the docstrings on `SupportsBatchPromotionStates` and `StoragePort`'s adjacent comment in
kohaku.spec.ports for the full explanation this test enforces.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

from kohaku.spec.ports import SupportsBatchPromotionStates


def _getattr_probe(storage: object) -> bool:
    """The pre-branch detection mechanism this Protocol replaced."""
    return getattr(storage, "put_promotion_states", None) is not None


class _RealBatchStorage:
    """A storage that concretely declares the method -- both mechanisms agree here."""

    async def put_promotion_states(self, states: list[object]) -> None: ...


class _NoBatchStorage:
    """A storage that does not have the method at all -- both mechanisms agree here."""


class _GetattrProxyStorage:
    """A storage that exposes the method dynamically via `__getattr__` (e.g. a tracing/instrumentation
    proxy). `getattr()` finds it; `isinstance` against a `runtime_checkable` Protocol does not, because
    CPython's `runtime_checkable` resolves members with `inspect.getattr_static`, which does not invoke
    `__getattr__`."""

    def __getattr__(self, name: str) -> object:
        if name == "put_promotion_states":
            return lambda states: None
        raise AttributeError(name)


class _NoneAttrStorage:
    """A storage where the attribute exists but is `None` (e.g. an unset optional hook placeholder). Both
    mechanisms agree it is absent: `getattr(..., None)` cannot distinguish "missing" from "present but
    None", and `isinstance` requires the resolved member to be present and non-None-callable."""

    put_promotion_states = None


def test_real_batch_storage_is_detected_by_both_mechanisms() -> None:
    storage = _RealBatchStorage()
    assert _getattr_probe(storage) is True
    assert isinstance(storage, SupportsBatchPromotionStates) is True


def test_storage_without_the_method_is_rejected_by_both_mechanisms() -> None:
    storage = _NoBatchStorage()
    assert _getattr_probe(storage) is False
    assert isinstance(storage, SupportsBatchPromotionStates) is False


def test_getattr_proxy_storage_is_a_mismatch_getattr_finds_it_isinstance_does_not() -> None:
    """The core semantic gap this test pins: a __getattr__-based proxy is detected by the old getattr
    probe but NOT by isinstance against the runtime_checkable Protocol. A StoragePort implemented this way
    (or wrapped by one) silently falls back to the per-state loop instead of the batch path."""
    storage = _GetattrProxyStorage()
    assert _getattr_probe(storage) is True
    assert isinstance(storage, SupportsBatchPromotionStates) is False


def test_async_mock_storage_is_a_mismatch_getattr_finds_it_isinstance_does_not() -> None:
    """A bare AsyncMock (as a downstream product's test double for StoragePort might use) auto-creates any
    attribute access, so the old getattr probe finds `put_promotion_states` -- but isinstance still does
    not, for the same getattr_static reason as the __getattr__ proxy above."""
    storage = AsyncMock()
    assert _getattr_probe(storage) is True
    assert isinstance(storage, SupportsBatchPromotionStates) is False


def test_none_valued_attribute_is_rejected_by_both_mechanisms() -> None:
    storage = _NoneAttrStorage()
    assert _getattr_probe(storage) is False
    assert isinstance(storage, SupportsBatchPromotionStates) is False
