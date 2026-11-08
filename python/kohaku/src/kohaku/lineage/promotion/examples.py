"""Reviewer-corrected few-shot examples for the schema extractor, mined from the lineage log
(Port of TS packages/lineage/src/promotion/examples.ts; design.md #73).

Differences from TS:
- An example is a plain dict `{"final": {...}, "suggestion"?: {...}, "htmlExcerpt"?: "..."}` of wire-form drafts
  (structurally `kohaku.evals.SchemaExtractionExample`; lineage may not import evals).
- The provider is `provider(input, signal=None)`: `input` is anything with a `tenant` attribute (the evals
  `SchemaExtractionInput`) or a mapping with a `tenant` key, and `signal` anything with an `aborted` flag (the
  extractor's examples-budget `AbortSignal`).
- `now` is injectable in milliseconds like TS (default: the monotonic clock in ms). The shared computation is an
  `asyncio.Task` awaited through `asyncio.shield`, so a caller cancelled mid-wait cannot cancel the result the
  next caller will reuse.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, TypedDict, TypeGuard

from kohaku.spec import LineageEventRecord, LineageFilter, StoragePort

DEFAULT_LIMIT = 2
DEFAULT_CACHE_TTL_MS = 5_000
"""How long one tenant's examples are reused before the log is read again."""
SCAN_WINDOW = 200
"""How many recent `component.schemaEdited` records are considered (one query)."""
ARTIFACT_WINDOW = 20
"""How many of one artifact's records a per-artifact lookup reads when no tenant narrows the query. The same
artifactId (a content hash) can be promoted by several tenants, whose records interleave; a tenant-less call keeps
only the tenant-less ones, so it reads a few more than the one it needs."""
HTML_EXCERPT_CHARS = 1_500
"""Characters of the artifact's HTML kept per example (the prompt side cuts to the same length)."""


class SchemaEditExample(TypedDict, total=False):
    """One reviewer-corrected case: the draft the reviewer finally approved (`final`, required), the machine
    proposal it replaced (`suggestion`) and the head of the component's HTML (`htmlExcerpt`)."""

    final: dict[str, Any]
    suggestion: dict[str, Any]
    htmlExcerpt: str


SchemaEditExamplesProvider = Callable[..., Awaitable[list[SchemaEditExample]]]


def _is_draft(value: Any) -> TypeGuard[Mapping[str, Any]]:
    if not isinstance(value, Mapping):
        return False
    return all(
        isinstance(value.get(key), str)
        for key in ("componentType", "version", "intentName", "description")
    )


def _now_ms() -> float:
    return time.monotonic() * 1000


def _tenant_of(input_: Any) -> str | None:
    tenant = (
        input_.get("tenant") if isinstance(input_, Mapping) else getattr(input_, "tenant", None)
    )
    return tenant if isinstance(tenant, str) and tenant != "" else None


def schema_edit_examples(
    storage: StoragePort,
    *,
    limit: int = DEFAULT_LIMIT,
    cache_ttl_ms: float = DEFAULT_CACHE_TTL_MS,
    now: Callable[[], float] | None = None,
) -> SchemaEditExamplesProvider:
    """Builds the `examples` provider for `kohaku.evals.create_schema_extractor` from the lineage log: the most
    recent cases where a reviewer **changed** the machine's schema suggestion (`component.schemaEdited` with a
    non-empty `changed`; an accepted-as-is suggestion teaches nothing new), newest first, at most one per
    artifact, each joined with that artifact's latest `component.schemaProposed` (the final draft; a case with
    none is skipped), `component.schemaSuggested` (the replaced proposal) and `component.generated` (the HTML).

    One read of the newest 200 `component.schemaEdited` records, and nothing more when none of them carries an
    edit. Only the artifacts that become examples (at most `limit`) are then looked up, each by its own
    `artifactId`. The result is reused per tenant for `cache_ttl_ms` (default 5 s; 0 turns the memo off), shared
    by calls that arrive while it is being computed. With a tenant only that tenant's records are read; without
    one only tenant-less records are used, so one tenant's component HTML and naming never reach another
    tenant's prompt. Read-only; a storage failure raises (and is not remembered), which the extractor treats as
    "no examples".
    """
    max_examples = max(0, int(limit))
    ttl_ms = max(0.0, cache_ttl_ms)
    clock = now if now is not None else _now_ms
    # tenant ("" for none) -> (started at, the shared computation); a failed one removes itself.
    memo: dict[str, tuple[float, asyncio.Task[list[SchemaEditExample]]]] = {}

    async def compute(tenant: str | None) -> list[SchemaEditExample]:
        # With a tenant the storage already narrows to it; the exact-match check only guards an adapter that
        # ignores the filter. Without one, "no tenant" means both an absent field and an empty string.
        def in_scope(e: LineageEventRecord) -> bool:
            return (
                e.tenant == tenant if tenant is not None else (e.tenant is None or e.tenant == "")
            )

        edited = [
            e
            for e in await storage.list_lineage(
                LineageFilter(type=["component.schemaEdited"], limit=SCAN_WINDOW, tenant=tenant)
            )
            if in_scope(e)
        ]
        # Newest first: by timestamp, and for equal timestamps the later append wins. One candidate per
        # artifact, and only an edit that actually changed the suggestion.
        candidates: list[str] = []
        seen: set[str] = set()
        newest_first = sorted(
            enumerate(edited), key=lambda item: (item[1].ts, item[0]), reverse=True
        )
        for _, event in newest_first:
            changed = event.payload.get("changed")
            artifact_id = event.payload.get("artifactId")
            if not isinstance(changed, list) or len(changed) == 0:
                continue
            if not isinstance(artifact_id, str) or artifact_id == "" or artifact_id in seen:
                continue
            seen.add(artifact_id)
            candidates.append(artifact_id)
        # Nothing was corrected: there is nothing to join, so do not read the other three event types at all.
        if len(candidates) == 0:
            return []

        async def latest_of(type_: str, artifact_id: str) -> LineageEventRecord | None:
            """The latest record of `type_` for one artifact (the log is in append order, so the last wins)."""
            records = [
                e
                for e in await storage.list_lineage(
                    LineageFilter(
                        type=[type_],
                        artifactId=artifact_id,
                        limit=1 if tenant is not None else ARTIFACT_WINDOW,
                        tenant=tenant,
                    )
                )
                if in_scope(e)
            ]
            return records[-1] if records else None

        examples: list[SchemaEditExample] = []
        for artifact_id in candidates:
            if len(examples) >= max_examples:
                break
            proposed = await latest_of("component.schemaProposed", artifact_id)
            final = proposed.payload.get("draft") if proposed is not None else None
            if not _is_draft(final):
                continue
            suggested, generated = await asyncio.gather(
                latest_of("component.schemaSuggested", artifact_id),
                latest_of("component.generated", artifact_id),
            )
            suggestion = suggested.payload.get("suggestion") if suggested is not None else None
            suggested_draft = suggestion.get("draft") if isinstance(suggestion, Mapping) else None
            html = generated.payload.get("html") if generated is not None else None
            example: SchemaEditExample = {"final": dict(final)}
            if _is_draft(suggested_draft):
                example["suggestion"] = dict(suggested_draft)
            if isinstance(html, str) and html != "":
                example["htmlExcerpt"] = html[:HTML_EXCERPT_CHARS]
            examples.append(example)
        return examples

    def _aborted(signal: Any) -> bool:
        # A function, not a captured value: the flag can flip while the shared computation is awaited below.
        return getattr(signal, "aborted", False) is True

    async def provider(input_: Any = None, signal: Any = None) -> list[SchemaEditExample]:
        if max_examples == 0 or _aborted(signal):
            return []
        tenant = _tenant_of(input_)
        key = tenant if tenant is not None else ""
        at = clock()
        entry = memo.get(key) if ttl_ms > 0 else None
        if entry is None or at - entry[0] >= ttl_ms:
            task = asyncio.ensure_future(compute(tenant))
            entry = (at, task)
            if ttl_ms > 0:
                for k in [k for k, (started, _) in memo.items() if at - started >= ttl_ms]:
                    del memo[k]
                memo[key] = entry

                def _forget(done: asyncio.Task[list[SchemaEditExample]], k: str = key) -> None:
                    # A failed computation must not be served again for the rest of the TTL.
                    if done.cancelled() or done.exception() is not None:
                        current = memo.get(k)
                        if current is not None and current[1] is done:
                            del memo[k]

                task.add_done_callback(_forget)
        result = await asyncio.shield(entry[1])
        if _aborted(signal):
            return []
        return list(result)

    return provider


__all__ = ["SchemaEditExample", "SchemaEditExamplesProvider", "schema_edit_examples"]
