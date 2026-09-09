"""kohaku.data_binding — the binding layer's client / server-side concerns (port of packages/data-binding).

The query:// URI canonicalization core (QueryRef / parse_query_ref / format_query_ref) is centralized in
kohaku.spec (duplicating canonicalization would cause binding authorization bypass / spurious 403). This
module re-exports it and owns the splitting of the reserved namespace (leading `_`) and the reference-passing
client (BindingClient).

BindingClient (TS client.ts) is a client SDK that resolves a Spec's $ref directly against the API, a
structural type that DI-injects a fetcher. The default HTTP fetcher is provided via httpx (an optional
dependency — lazily imported in client.py).
"""

# Centralize the import path (the same re-export as TS index.ts).
from kohaku.spec import (  # noqa: F401  (re-export)
    QueryRef,
    QueryRefError,
    enumerate_bind_variants,
    format_query_ref,
    parse_query_ref,
    resolve_bound_ref,
)

from .client import (
    ActionFetcher,
    ActionOptions,
    ActionResult,
    BindingClient,
    BindingClientConfig,
    BindingFetcher,
    FetchInit,
    FetchResponseLike,
    PageOptions,
    ResolveOptions,
    SortOptions,
    create_binding_client,
    create_httpx_action_fetcher,
    create_httpx_fetcher,
)
from .errors import BindingError, BindingErrorCode
from .query_ref import (
    KNOWN_RESERVED_PARAMS,
    RESERVED_PARAM_PREFIX,
    SplitRef,
    assert_known_reserved_params,
    split_reserved_params,
)

__all__ = [
    "KNOWN_RESERVED_PARAMS",
    "RESERVED_PARAM_PREFIX",
    "ActionFetcher",
    "ActionOptions",
    "ActionResult",
    "BindingClient",
    "BindingClientConfig",
    "BindingError",
    "BindingErrorCode",
    "BindingFetcher",
    "FetchInit",
    "FetchResponseLike",
    "PageOptions",
    "QueryRef",
    "QueryRefError",
    "ResolveOptions",
    "SortOptions",
    "SplitRef",
    "assert_known_reserved_params",
    "create_binding_client",
    "create_httpx_action_fetcher",
    "create_httpx_fetcher",
    "enumerate_bind_variants",
    "format_query_ref",
    "parse_query_ref",
    "resolve_bound_ref",
    "split_reserved_params",
]
