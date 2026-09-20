"""kohaku.host_core.binding_ref — parses a `query://` ref into base/reserved/merged params and classifies its
source (port of packages/host-core/src/binding-ref.ts).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from kohaku.data_binding import assert_known_reserved_params, split_reserved_params
from kohaku.spec import JsonObject, QueryRef


@dataclass(frozen=True)
class InvokableRef:
    """A parsed read-ref, ready for both capability verification (against `base.raw`) and `domain.invoke`
    (with `params`). Shared shape for the three read-ref sites that used to duplicate this parsing: REST's
    /binding/resolve, MCP's `${prefix}_resolve_binding` tool, and MCP's initial-data preresolution
    (host_mcp's `_resolve_variant`).
    """

    base: QueryRef
    """The canonical base ref with reserved parameters (leading `_`) removed. `base.raw` is what capability
    verification matches exactly (it equals the original Spec `$ref`, which never carries reserved params),
    and `base.path` is the first `domain.invoke` argument."""
    reserved: dict[str, str]
    """Reserved parameters (`_cursor`/`_limit`/`_sort`/`_dir`) split out of the ref."""
    params: JsonObject
    """`{**base.params, **reserved}` in that order — the exact second argument every call site passes to
    `domain.invoke` (the `_` namespace convention; DomainPort itself is unaware of reserved params)."""


@dataclass(frozen=True)
class ParsedInvokableRefOk:
    """`parse_invokable_ref` succeeded: `ref.base.source` matched the host's `query_source`."""

    ref: InvokableRef
    kind: Literal["ok"] = "ok"


@dataclass(frozen=True)
class ParsedInvokableRefSourceMismatch:
    """`parse_invokable_ref`'s ref has a source other than the host's `query_source` (not an error — the host
    maps this to its own "not an embedding target" / 404 / tool-error response)."""

    source: str
    kind: Literal["source_mismatch"] = "source_mismatch"


type ParsedInvokableRef = ParsedInvokableRefOk | ParsedInvokableRefSourceMismatch


def parse_invokable_ref(ref: str, query_source: str) -> ParsedInvokableRef:
    """Parses a `query://` ref into base/reserved/merged-params (via data_binding's `split_reserved_params` +
    `assert_known_reserved_params`) and classifies whether its source matches the host's `query_source`.

    This is **pure parse/merge only** — no capability verification, no `domain.invoke` call, no error →
    response mapping. Each call site (REST route, MCP tool, MCP initial-data preresolution) keeps its own
    verify step (or, for initial-data, the deliberate absence of one) and its own error → status/tool-error/
    None mapping around this function; only the triplicated split/assert/merge/source-check moves here.

    Raises exactly what `split_reserved_params` (malformed `query://` URI) and `assert_known_reserved_params`
    (an unknown `_`-prefixed key) raise, so callers that already catch those exceptions and turn them into a
    400 / tool error keep working unchanged.
    """
    split = split_reserved_params(ref)
    assert_known_reserved_params(split.reserved)
    if split.base.source != query_source:
        return ParsedInvokableRefSourceMismatch(source=split.base.source)
    return ParsedInvokableRefOk(
        ref=InvokableRef(
            base=split.base,
            reserved=split.reserved,
            params={**split.base.params, **split.reserved},
        )
    )
