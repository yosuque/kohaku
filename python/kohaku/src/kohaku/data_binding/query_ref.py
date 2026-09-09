"""Splitting of the reserved namespace (leading `_`) (port of TS data-binding/query-ref.ts)."""

from __future__ import annotations

from dataclasses import dataclass

from kohaku.spec import QueryRef, format_query_ref, parse_query_ref

RESERVED_PARAM_PREFIX = "_"
"""Reserved-parameter prefix for server-side paging/sort."""

KNOWN_RESERVED_PARAMS: frozenset[str] = frozenset({"_cursor", "_limit", "_sort", "_dir"})
"""Known keys of the reserved namespace (SPEC §2.3). Only the wire representation of paging/sort is allowed."""


@dataclass(frozen=True)
class SplitRef:
    base: QueryRef
    """The base ref with reserved parameters removed. It is the target of capability validation and canonical
    caching, and matches the original Spec `$ref` (which contains no reserved parameters)."""
    reserved: dict[str, str]
    """Reserved parameters with a leading `_` (`_cursor` / `_limit` / `_sort` / `_dir`, etc.)."""


def split_reserved_params(uri: str) -> SplitRef:
    """Split a ref into base (the canonical form with reserved parameters removed) and reserved (leading `_`).

    Capability validation is performed by exact match against `base.raw` (= the original $ref the Spec
    declared), and reserved parameters are merged with base.params into domain.invoke (the `_` namespace
    convention).
    """
    parsed = parse_query_ref(uri)
    base_params: dict[str, str] = {}
    reserved: dict[str, str] = {}
    for k, v in parsed.params.items():
        if k.startswith(RESERVED_PARAM_PREFIX):
            reserved[k] = v
        else:
            base_params[k] = v
    raw = format_query_ref(source=parsed.source, path=parsed.path, params=base_params)
    base = QueryRef(source=parsed.source, path=parsed.path, params=base_params, raw=raw)
    return SplitRef(base=base, reserved=reserved)


class UnknownReservedParamError(ValueError):
    """Raised when a ref carries a reserved (`_`-prefixed) parameter outside the known set. Carries `code` so
    it is recognized as a deliberate, host-authored validation error (kohaku.host_core.is_typed_host_error) —
    its message still reaches the caller (a 400 body / tool error) instead of collapsing to a generic
    internal-error text on hosts that route it through their catch-all error handling (MCP's
    `${prefix}_resolve_binding`, which — unlike REST's /binding/resolve — has no dedicated try/except around
    this call).
    """

    code = "UNKNOWN_RESERVED_PARAM"


def assert_known_reserved_params(reserved: dict[str, str]) -> None:
    """Throw if reserved contains any unknown `_` key (boundary defense).

    The reserved namespace is dedicated to "reordering / slicing" and is outside capability validation, so
    passing an unknown key straight through to the DomainPort would let an out-of-authorization parameter
    change "which data is returned".
    """
    for key in reserved:
        if key not in KNOWN_RESERVED_PARAMS:
            raise UnknownReservedParamError(
                f'unknown reserved parameter "{key}" is not allowed (allowed: _cursor / _limit / _sort / _dir)'
            )
