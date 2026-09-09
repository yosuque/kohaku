"""A declarative query:// template (port of query-template.ts).

Expresses the mapping from intent params to query params purely declaratively. Same shape as a promoted
ComponentDraft.queryTemplate (unifying the promotion path and the core Intent path into one helper).
- path: the query path (e.g. "trend")
- fixedParams: fixed parameters always added (values pass through; not filtered)
- paramMap: intent param name → query param name (only non-null / non-empty values are String()-converted and added)
"""

from __future__ import annotations

from dataclasses import dataclass

from kohaku.data_binding import format_query_ref
from kohaku.spec import JsonObject, QueryHandle, js_string


@dataclass(frozen=True)
class QueryTemplate:
    path: str
    paramMap: dict[str, str] | None = None
    fixedParams: dict[str, str] | None = None


def compile_query_template(
    source: str, template: QueryTemplate, params: JsonObject
) -> QueryHandle:
    """Expand a QueryTemplate + params into a canonical query:// URI (QueryHandle).

    Canonicalization (key sorting, etc.) is delegated to data-binding's format_query_ref (= spec-core's canonical
    form) to avoid double definition. null / empty-string paramMap values are not added (a missing value passes through).
    """
    query_params: dict[str, str] = dict(template.fixedParams or {})
    for intent_param, query_param in (template.paramMap or {}).items():
        value = params.get(intent_param)
        # TS's `value != null && value !== ""`. Missing (None) and empty string are not added.
        if value is not None and value != "":
            query_params[query_param] = js_string(value)
    return QueryHandle(
        uri=format_query_ref(source=source, path=template.path, params=query_params)
    )
