"""Tests for parse_invokable_ref (port of packages/host-core/src/binding-ref.ts).

TS host-core has no dedicated binding-ref.test.ts of its own — parseInvokableRef is exercised indirectly
through packages/host-rest/test/binding-resolve.test.ts and packages/host-mcp-apps/test/{mcp,initial-data-ref}
.test.ts. These cases are lifted directly from binding-resolve.test.ts's "reserved parameters / base-ref
verification of GET /binding/resolve" describe block (the concrete refs/values are copied verbatim), adapted
to call the pure host_core function directly instead of going through the REST route.
"""

from __future__ import annotations

import pytest

from kohaku.data_binding.query_ref import UnknownReservedParamError
from kohaku.host_core.binding_ref import (
    ParsedInvokableRefOk,
    ParsedInvokableRefSourceMismatch,
    parse_invokable_ref,
)
from kohaku.spec import QueryRefError

QUERY_SOURCE = "sales"


def test_ref_with_reserved_parameters_splits_base_and_merges_params_in_base_then_reserved_order() -> None:
    # Mirrors binding-resolve.test.ts's "even for a ref with reserved parameters, verifies the capability
    # against the base and merges reserved into domain".
    parsed = parse_invokable_ref(
        "query://sales/records?_cursor=100:v1&_dir=desc&_limit=50&_sort=revenue&fy=2026",
        QUERY_SOURCE,
    )
    assert isinstance(parsed, ParsedInvokableRefOk)
    assert parsed.kind == "ok"
    assert parsed.ref.base.raw == "query://sales/records?fy=2026"
    assert parsed.ref.reserved == {
        "_cursor": "100:v1",
        "_dir": "desc",
        "_limit": "50",
        "_sort": "revenue",
    }
    assert parsed.ref.params == {
        "fy": "2026",
        "_cursor": "100:v1",
        "_dir": "desc",
        "_limit": "50",
        "_sort": "revenue",
    }


def test_an_unknown_reserved_parameter_raises() -> None:
    # Mirrors binding-resolve.test.ts's "an unknown `_` parameter is 400 BAD_REQUEST".
    with pytest.raises(UnknownReservedParamError) as exc_info:
        parse_invokable_ref("query://sales/records?_tenant=other&fy=2026", QUERY_SOURCE)
    assert exc_info.value.code == "UNKNOWN_RESERVED_PARAM"


def test_a_normal_ref_without_reserved_parameters_is_ok_with_no_reserved_entries() -> None:
    # Mirrors binding-resolve.test.ts's "a normal ref without reserved parameters is verified and invoked
    # against the base (regression)".
    parsed = parse_invokable_ref("query://sales/records?fy=2026", QUERY_SOURCE)
    assert isinstance(parsed, ParsedInvokableRefOk)
    assert parsed.ref.reserved == {}
    assert parsed.ref.params == {"fy": "2026"}
    assert parsed.ref.base.raw == "query://sales/records?fy=2026"


def test_a_ref_whose_source_does_not_match_query_source_is_source_mismatch() -> None:
    # Mirrors binding-resolve.test.ts's "a ref whose source does not match querySource is 404
    # SOURCE_MISMATCH, without verifying or invoking" — the classification only; the 404 mapping stays in
    # the REST host.
    parsed = parse_invokable_ref("query://other/records?fy=2026", QUERY_SOURCE)
    assert isinstance(parsed, ParsedInvokableRefSourceMismatch)
    assert parsed.kind == "source_mismatch"
    assert parsed.source == "other"


def test_a_malformed_query_uri_raises_query_ref_error() -> None:
    # The source-check happens after split_reserved_params/assert_known_reserved_params, so a malformed URI
    # (not query://<source>/<path>?<params>) still raises QueryRefError, same as split_reserved_params itself.
    with pytest.raises(QueryRefError):
        parse_invokable_ref("not-a-query-ref", QUERY_SOURCE)
