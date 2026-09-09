"""Client for reference-passing data binding (port of TS data-binding/client.ts).

Resolves a Spec's $ref directly against the API so that bulk data never enters the model context (the
reference-passing principle). composer / LLM never touch this package at all (what the LLM assembles is the
plumbing, not the water). fetcher / action_fetcher are DI'd (structural Callables); the default
implementation is httpx-based (create_httpx_fetcher / create_httpx_action_fetcher).

Intentional differences from TS:
- fetcher is implemented with httpx rather than TS's global fetch (the default HTTP fetcher). httpx is a
  dependency of the llm extra and treated as optional from data_binding: lazily imported, and raising an
  error when not installed.
- For resolve's return value, TS returns the raw payload typed as `TabularData` via a structural interface,
  but Python's TabularData (pydantic) requires dataVersion and cannot express the SPEC's SHOULD (may be
  omitted), so it returns the raw payload (JsonObject) as-is (the shallow shape check / STALE reconciliation
  are identical to TS).
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, cast

from kohaku.spec import (
    JsonObject,
    JsonValue,
    QueryRef,
    QueryRefError,
    canonical_stringify,
    format_query_ref,
    parse_query_ref,
)

from .errors import BindingError
from .query_ref import RESERVED_PARAM_PREFIX

type AbortSignalLike = object
"""Environment-neutral abort signal (equivalent to TS's unknown). Passed straight through to the fetcher; its contents are not interpreted."""


@dataclass(frozen=True)
class FetchResponseLike:
    """Return of fetcher / action_fetcher (a minimal representation of an HTTP response)."""

    status: int
    body: Any


@dataclass(frozen=True)
class FetchInit:
    """Invocation context passed to fetcher / action_fetcher."""

    capability: str | None = None
    signal: AbortSignalLike | None = None


# Function for swapping out the default HTTP fetcher (for tests and the MCP bridge).
type BindingFetcher = Callable[[QueryRef, FetchInit], Awaitable[FetchResponseLike]]
type ActionFetcher = Callable[[str, JsonValue, FetchInit], Awaitable[FetchResponseLike]]

type CapabilitySource = str | Callable[[], str | None]
"""capability token. If a function, evaluated on every call (equivalent to TS's `string | (() => string | undefined)`)."""


@dataclass(frozen=True)
class PageOptions:
    """Server-side paging. Projected onto the reserved parameters `_cursor` / `_limit`."""

    cursor: str | None = None
    limit: int | None = None


@dataclass(frozen=True)
class SortOptions:
    """Server-side sort. Projected onto the reserved parameters `_sort` / `_dir`."""

    key: str
    dir: Literal["asc", "desc"]


@dataclass(frozen=True)
class ResolveOptions:
    signal: AbortSignalLike | None = None
    expected_data_version: str | None = None
    """The Spec's dataVersion. If it does not match the returned data, throws STALE_VERSION."""
    page: PageOptions | None = None
    sort: SortOptions | None = None


@dataclass(frozen=True)
class ActionOptions:
    """Options for invoke_action."""

    signal: AbortSignalLike | None = None
    """Per-request cancellation. Propagated to action_fetcher's init.signal (symmetric with fetcher)."""


@dataclass(frozen=True)
class ActionResult:
    """Result of the direct write path (invoke_action).

    - invalidates: `query://` URIs to invalidate (exact match).
    - refVersions: new per-ref data versions (consistent with per-ref reconciliation; the target to reconcile against on re-resolve).
    """

    result: JsonValue
    invalidates: list[str] | None = None
    refVersions: dict[str, str] | None = None


@dataclass(frozen=True)
class BindingClientConfig:
    """Configuration for create_binding_client (equivalent to TS's BindingClientConfig)."""

    base_url: str | None = None
    """Mount point of host-rest (e.g. "/api/kohaku"). Not needed when a fetcher is provided."""
    capability: CapabilitySource | None = None
    headers: Callable[[], dict[str, str] | None] | None = None
    """Extra headers the default fetcher attaches to every resolve / action request (a function, so evaluated each time).
    Carries things like the multi-tenant x-kohaku-tenant header or a trace ID. When a custom fetcher is provided, that is its responsibility."""
    fetcher: BindingFetcher | None = None
    action_fetcher: ActionFetcher | None = None
    timeout_s: float = 30.0
    """Timeout in seconds for the default (httpx) fetcher."""


class BindingClient:
    """Client for reference-passing data binding. Created by create_binding_client."""

    def __init__(
        self,
        *,
        fetcher: BindingFetcher,
        action_fetcher: ActionFetcher | None,
        capability: Callable[[], str | None],
        headers: Callable[[], dict[str, str]] | None = None,
    ) -> None:
        self._fetcher = fetcher
        self._action_fetcher = action_fetcher
        self._capability = capability
        # Used only to build the dedup fingerprint below (see resolve); the actual request headers remain
        # the fetcher's own responsibility (its own closure over config.headers, same as before this fix).
        self._headers = headers if headers is not None else (lambda: {})
        # In-flight sharing (dedup) for the same $ref. Key = normalized ref + expected_data_version.
        # On completion or failure it is always removed in the done callback (prevents a failure from being cached permanently).
        self._inflight: dict[str, asyncio.Task[JsonObject]] = {}

    async def resolve(
        self, ref_input: str | Mapping[str, str], opts: ResolveOptions | None = None
    ) -> JsonObject:
        o = opts if opts is not None else ResolveOptions()
        uri = ref_input if isinstance(ref_input, str) else ref_input["$ref"]
        try:
            ref = parse_query_ref(uri)
        except QueryRefError as e:
            raise BindingError("BAD_REF", str(e)) from e
        # The reserved namespace (leading `_`) is only added via page/sort. Its presence in the $ref itself is a misuse.
        if any(k.startswith(RESERVED_PARAM_PREFIX) for k in ref.params):
            raise BindingError(
                "BAD_REF", f"reserved parameters (_*) are not allowed in a $ref: {ref.raw}"
            )
        # Project page / sort onto reserved parameters and merge/re-canonicalize them into the ref (if unspecified, the ref is unchanged = backward compatible).
        reserved = _reserved_from_options(o)
        if reserved:
            merged = {**ref.params, **reserved}
            ref = QueryRef(
                source=ref.source,
                path=ref.path,
                params=merged,
                raw=format_query_ref(source=ref.source, path=ref.path, params=merged),
            )

        # Pin the auth context (capability + headers) once, here, before dedup. config.capability /
        # config.headers may be callables whose result changes between concurrent calls (e.g. a tenant
        # switch mid-flight) — evaluating them once, up front, keeps the value used for the dedup
        # fingerprint below and the value `run` actually sends on the wire in agreement (both are
        # evaluated synchronously in the same tick as this call, before any await).
        cap = self._capability()
        hdrs = self._headers()

        async def run() -> JsonObject:
            resp = await self._fetcher(ref, FetchInit(capability=cap, signal=o.signal))
            status = resp.status
            if status in (401, 403):
                raise BindingError("UNAUTHORIZED", f"binding resolve denied for {ref.raw}", status=status)
            if status == 404:
                raise BindingError("REF_NOT_FOUND", f"no data source for {ref.raw}", status=status)
            if status < 200 or status >= 300:
                raise BindingError(
                    "RESOLVE_FAILED", f"binding resolve failed ({status}) for {ref.raw}", status=status
                )
            body = resp.body
            if not isinstance(body, dict) or not isinstance(body.get("rows"), list) or not isinstance(
                body.get("columns"), list
            ):
                raise BindingError("RESOLVE_FAILED", f"malformed tabular payload for {ref.raw}")
            # Shallowly validate only column.key, which the renderer always references (deep validation is excessive, so we do not do it).
            if not all(
                isinstance(c, dict) and isinstance(c.get("key"), str) for c in body["columns"]
            ):
                raise BindingError("RESOLVE_FAILED", f"malformed columns for {ref.raw}")
            # dataVersion is SHOULD (may be omitted), but if present it must be a string (explicit null is treated as present).
            if "dataVersion" in body and not isinstance(body["dataVersion"], str):
                raise BindingError("RESOLVE_FAILED", f"malformed dataVersion for {ref.raw}")
            data_version = body.get("dataVersion")
            # When expected_data_version is specified, fall to STALE whether the response omits it (reconciliation impossible) or mismatches (fail-closed).
            if o.expected_data_version is not None and data_version != o.expected_data_version:
                raise BindingError(
                    "STALE_VERSION",
                    f"data version mismatch: spec={o.expected_data_version} data={data_version}",
                )
            return cast("JsonObject", body)

        # Requests with a signal are excluded from dedup (prevents a leading call's abort from propagating to unrelated waiters).
        if o.signal is not None:
            return await run()

        # Dedup key: normalized ref + expected_data_version + an auth-context fingerprint (the
        # capability string plus a canonical, key-sorted serialization of the headers object). Without
        # the fingerprint, two concurrent resolves of the same ref under different auth contexts (e.g.
        # tenant A's resolve still in flight when the same client instance switches to tenant B and
        # resolves the same ref) would collide on the same key, and the second caller would silently
        # receive the first caller's in-flight response instead of its own. NOTE: when a custom fetcher /
        # action_fetcher is provided, config.headers is not necessarily consulted by it at all (that is
        # the custom fetcher's own responsibility), so for that case this fingerprint's headers component
        # may not reflect what actually goes on the wire; dedup safety there rests on the `capability`
        # half plus whatever auth signal the custom fetcher itself keys on.
        key = f"{ref.raw} {o.expected_data_version or ''} {cap or ''} {canonical_stringify(hdrs)}"
        existing = self._inflight.get(key)
        if existing is not None:
            return await existing
        task = asyncio.ensure_future(run())
        self._inflight[key] = task
        # Once settled (including failure) remove it from the Map (equivalent to TS's finally; errors propagate to waiters).
        task.add_done_callback(lambda _t: self._inflight.pop(key, None))
        return await task

    async def invoke_action(
        self, action: str, payload: JsonValue, opts: ActionOptions | None = None
    ) -> ActionResult:
        o = opts if opts is not None else ActionOptions()
        if self._action_fetcher is None:
            raise BindingError("RESOLVE_FAILED", "action fetcher is not configured")
        resp = await self._action_fetcher(
            action, payload, FetchInit(capability=self._capability(), signal=o.signal)
        )
        if resp.status in (401, 403):
            raise BindingError("UNAUTHORIZED", f'action "{action}" denied', status=resp.status)
        if resp.status < 200 or resp.status >= 300:
            raise BindingError(
                "RESOLVE_FAILED", f'action "{action}" failed ({resp.status})', status=resp.status
            )
        return _parse_action_result(resp.body)


def create_binding_client(config: BindingClientConfig) -> BindingClient:
    """Assemble a BindingClient from the config. When no fetcher is given and base_url is set, use the default httpx fetcher."""

    def capability() -> str | None:
        c = config.capability
        return c() if callable(c) else c

    def headers() -> dict[str, str]:
        h = config.headers
        return (h() if h is not None else None) or {}

    fetcher = config.fetcher
    if fetcher is None and config.base_url is not None:
        fetcher = create_httpx_fetcher(
            config.base_url, headers=config.headers, timeout_s=config.timeout_s
        )
    if fetcher is None:
        raise BindingError("RESOLVE_FAILED", "either base_url or fetcher is required")

    action_fetcher = config.action_fetcher
    if action_fetcher is None and config.base_url is not None:
        action_fetcher = create_httpx_action_fetcher(
            config.base_url, headers=config.headers, timeout_s=config.timeout_s
        )
    return BindingClient(
        fetcher=fetcher, action_fetcher=action_fetcher, capability=capability, headers=headers
    )


def _reserved_from_options(opts: ResolveOptions) -> dict[str, str]:
    """Project ResolveOptions' page / sort onto query:// reserved parameters (leading `_`)."""
    reserved: dict[str, str] = {}
    if opts.page is not None:
        if opts.page.cursor is not None:
            reserved["_cursor"] = opts.page.cursor
        if opts.page.limit is not None:
            reserved["_limit"] = str(opts.page.limit)
    if opts.sort is not None:
        reserved["_sort"] = opts.sort.key
        reserved["_dir"] = opts.sort.dir
    return reserved


def _parse_action_result(body: Any) -> ActionResult:
    """Shape the /binding/action response body into an ActionResult.

    If the response has the form `{ result, invalidates?, refVersions? }`, adopt it as-is; otherwise wrap
    the whole body as result (backward compatible with hosts that have not wired up action_effects).
    """
    if isinstance(body, dict) and "result" in body:
        invalidates: list[str] | None = None
        inv = body.get("invalidates")
        if isinstance(inv, list) and all(isinstance(x, str) for x in inv):
            invalidates = list(inv)
        ref_versions: dict[str, str] | None = None
        rv = body.get("refVersions")
        if isinstance(rv, dict):
            entries = {k: v for k, v in rv.items() if isinstance(v, str)}
            if entries:
                ref_versions = entries
        return ActionResult(result=body["result"], invalidates=invalidates, refVersions=ref_versions)
    return ActionResult(result=body if body is not None else None)


def _import_httpx() -> Any:
    """Lazily import httpx (an optional dependency from data_binding). Raises an error if not installed."""
    try:
        import httpx
    except ImportError as e:
        raise RuntimeError(
            "the default HTTP fetcher requires httpx. Install it with `uv sync` or"
            " `pip install 'kohaku[llm]'`, or inject a fetcher / action_fetcher explicitly"
        ) from e
    return httpx


def create_httpx_fetcher(
    base_url: str,
    *,
    headers: Callable[[], dict[str, str] | None] | None = None,
    timeout_s: float = 30.0,
    transport: Any = None,
) -> BindingFetcher:
    """httpx-based BindingFetcher that hits /binding/resolve under base_url.

    transport is the hook for injecting httpx.MockTransport in tests (default None = real HTTP).
    """

    async def fetcher(ref: QueryRef, init: FetchInit) -> FetchResponseLike:
        httpx = _import_httpx()
        hdrs: dict[str, str] = dict((headers() if headers is not None else None) or {})
        if init.capability is not None:
            hdrs["Authorization"] = f"Bearer {init.capability}"
        async with httpx.AsyncClient(transport=transport, timeout=timeout_s) as http:
            res = await http.get(
                f"{base_url}/binding/resolve", params={"ref": ref.raw}, headers=hdrs
            )
        return FetchResponseLike(status=res.status_code, body=_safe_json(res))

    return fetcher


def create_httpx_action_fetcher(
    base_url: str,
    *,
    headers: Callable[[], dict[str, str] | None] | None = None,
    timeout_s: float = 30.0,
    transport: Any = None,
) -> ActionFetcher:
    """httpx-based ActionFetcher that hits /binding/action under base_url."""

    async def action_fetcher(action: str, payload: JsonValue, init: FetchInit) -> FetchResponseLike:
        httpx = _import_httpx()
        hdrs: dict[str, str] = {
            **((headers() if headers is not None else None) or {}),
            "content-type": "application/json",
        }
        if init.capability is not None:
            hdrs["Authorization"] = f"Bearer {init.capability}"
        async with httpx.AsyncClient(transport=transport, timeout=timeout_s) as http:
            res = await http.post(
                f"{base_url}/binding/action",
                json={"action": action, "payload": payload},
                headers=hdrs,
            )
        return FetchResponseLike(status=res.status_code, body=_safe_json(res))

    return action_fetcher


def _safe_json(res: Any) -> Any:
    """Treat a non-JSON response as None (symmetric with the TS default fetcher's `.catch(() => null)`)."""
    try:
        return res.json()
    except Exception:  # noqa: BLE001 — fall a non-JSON response body to None
        return None
