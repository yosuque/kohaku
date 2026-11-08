"""The default SemanticPort (port of packages/semantic-llm/src/port.ts).

GUI operations are deterministic, natural language is mapped onto the Intent catalog by the LLM, and both
converge on the same IntentInput. Intent definitions come from `kohaku.intents`; queries are resolved from
them (reference passing -- no rows ever enter the model's context).

This is a starting point (adoption-ladder Step 1). The Intent layer remains a product responsibility: replace
it with your own SemanticPort when the catalog, prompt or fallback policy outgrow these options.
"""

from __future__ import annotations

import inspect
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal

from kohaku.llm import LlmPort
from kohaku.spec import (
    DataShape,
    GuiAction,
    Intent,
    IntentInput,
    IntentValidationError,
    NLQuery,
    QueryHandle,
    QueryRef,
    SemanticInput,
    SessionContext,
    parse_query_ref,
)

from .catalog import IntentCatalogLike
from .gui import normalize_gui_action
from .nl import normalize_nl_query

_LOCALE_TAG = re.compile(r"[A-Za-z0-9-]{1,35}")
"""A BCP-47-like language tag: ASCII letters, digits and hyphens, at most 35 characters."""


def default_output_locale(locale: str | None) -> str:
    """The default `output_locale`: the "(locale)" label in the normalizer's user prompt. The tag comes from
    the client (`NLQuery.locale`) and is interpolated outside the USER_QUESTION delimiter block, so anything
    that is not a BCP-47-like tag (ASCII letters, digits, hyphens; at most 35 characters) is replaced by
    "und" (undetermined) instead of reaching the prompt verbatim. An absent tag is "en". A custom
    `output_locale` replaces this entirely and owns its own sanitization. Port of TS `defaultOutputLocale`
    (pinned by the cross-language golden `semanticLocale`)."""
    if locale is None:
        return "en"
    return locale if _LOCALE_TAG.fullmatch(locale) is not None else "und"


class UnknownIntentError(Exception):
    """Thrown by resolve_query when the intent's canonical name is not present in the (possibly per-tenant)
    catalog. Carries a string `code` (the general convention for a "typed" internal error) and, separately,
    `clientSafe = True` -- the narrower, explicit opt-in composer's SEMANTIC_FAILED wrapping requires before it
    appends a cause's own message (see kohaku.composer.compose._is_client_safe_cause). The message names no
    internals, only the (already client-supplied) intent name.
    """

    code: Literal["UNKNOWN_INTENT"] = "UNKNOWN_INTENT"
    clientSafe: Literal[True] = True
    """Opts in to composer's SEMANTIC_FAILED message enrichment."""

    def __init__(self, canonical: str) -> None:
        super().__init__(f'unknown intent "{canonical}"')
        self.canonical = canonical


@dataclass(frozen=True)
class NormalizedInfo:
    """What `on_normalized` receives after every successful NL normalization."""

    text: str
    canonical: str
    fallback: bool
    tenant: str | None = None


class LlmSemanticPort:
    """The SemanticPort implementation built by `create_llm_semantic_port` (a structural SemanticPort that
    also implements the optional `validate_intent` extension, `kohaku.spec.ports.SupportsValidateIntent`)."""

    def __init__(
        self,
        *,
        llm: LlmPort,
        catalog: IntentCatalogLike | Callable[[str | None], IntentCatalogLike],
        data_version: Callable[[QueryHandle], str | Awaitable[str]],
        describe_shape: Callable[[QueryRef], DataShape | None] | None = None,
        rules: Callable[[SessionContext], list[str]] | None = None,
        fallback_intent: str | None = None,
        output_locale: Callable[[str | None], str] | None = None,
        max_question_chars: int | None = None,
        on_normalized: Callable[[NormalizedInfo], None] | None = None,
    ) -> None:
        self._llm = llm
        self._catalog = catalog
        self._data_version = data_version
        self._describe_shape = describe_shape
        self._rules = rules
        self._fallback_intent = fallback_intent
        self._output_locale = output_locale
        self._max_question_chars = max_question_chars
        self._on_normalized = on_normalized

    def _catalog_for(self, tenant: str | None) -> IntentCatalogLike:
        if callable(self._catalog):
            return self._catalog(tenant)
        return self._catalog

    async def normalize(self, input: SemanticInput, ctx: SessionContext) -> IntentInput:
        catalog = self._catalog_for(ctx.tenant)
        if isinstance(input, GuiAction):
            return normalize_gui_action(input, catalog)
        assert isinstance(input, NLQuery)
        locale_tag = input.locale if input.locale is not None else ctx.locale
        output_locale = (
            self._output_locale if self._output_locale is not None else default_output_locale
        )
        locale = output_locale(locale_tag)
        result = await normalize_nl_query(
            input=input,
            catalog=catalog,
            llm=self._llm,
            rules=self._rules(ctx) if self._rules is not None else [],
            locale=locale,
            fallback_intent=self._fallback_intent,
            max_question_chars=self._max_question_chars,
        )
        if self._on_normalized is not None:
            try:
                self._on_normalized(
                    NormalizedInfo(
                        text=input.text,
                        canonical=result.canonical,
                        fallback=result.fallback,
                        tenant=ctx.tenant,
                    )
                )
            except Exception:  # noqa: BLE001,S110
                pass  # Fail-open: an observation hook must never break normalization.
        return IntentInput(canonical=result.canonical, params=result.params)

    async def resolve_query(
        self, intent: Intent, *, tenant: str | None = None
    ) -> list[QueryHandle]:
        def_ = self._catalog_for(tenant).get(intent.canonical)
        if def_ is None:
            raise UnknownIntentError(intent.canonical)
        return def_.to_queries(intent.params)

    async def data_version(self, handle: QueryHandle) -> str:
        version = self._data_version(handle)
        if inspect.isawaitable(version):
            return await version
        return version

    async def describe_shape(self, handle: QueryHandle) -> DataShape | None:
        """Column metadata for the handle's ref (no rows). TS leaves `describeShape` undefined when the option
        is omitted; Python's SemanticPort protocol requires the method, so it returns None then (the protocol's
        "no shape provided" answer). A configured callback returning None for a path means an unknown path and
        throws."""
        if self._describe_shape is None:
            return None
        ref = parse_query_ref(handle.uri)
        shape = self._describe_shape(ref)
        if shape is None:
            raise ValueError(f"unknown query path: {ref.path}")
        return shape

    async def validate_intent(self, intent: IntentInput, ctx: SessionContext) -> IntentInput:
        """Validates and normalizes a directly-specified Intent (backs `kohaku.host_core.intent.resolve_intent`'s
        "intent" source): an unknown canonical or an unknown/invalid param is rejected with
        IntentValidationError instead of reaching finalize_intent unchecked. Uses the per-tenant catalog."""
        catalog = self._catalog_for(ctx.tenant)
        validate_params = getattr(catalog, "validate_params", None)
        if validate_params is not None:
            result = validate_params(intent.canonical, intent.params)
            if result.ok:
                assert result.params is not None
                return IntentInput(canonical=intent.canonical, params=result.params)
            raise IntentValidationError(
                "; ".join(issue.message for issue in result.issues), result.issues
            )
        # The catalog does not implement validate_params: fall back to the looser (name-known?,
        # normalize_params) checks, which cannot detect an unknown param key or report per-key issues.
        if catalog.get(intent.canonical) is None:
            raise IntentValidationError(f'unknown intent "{intent.canonical}"')
        params = catalog.normalize_params(intent.canonical, intent.params)
        if params is None:
            raise IntentValidationError(f'invalid params for intent "{intent.canonical}"')
        return IntentInput(canonical=intent.canonical, params=params)


def create_llm_semantic_port(
    *,
    llm: LlmPort,
    catalog: IntentCatalogLike | Callable[[str | None], IntentCatalogLike],
    data_version: Callable[[QueryHandle], str | Awaitable[str]],
    describe_shape: Callable[[QueryRef], DataShape | None] | None = None,
    rules: Callable[[SessionContext], list[str]] | None = None,
    fallback_intent: str | None = None,
    output_locale: Callable[[str | None], str] | None = None,
    max_question_chars: int | None = None,
    on_normalized: Callable[[NormalizedInfo], None] | None = None,
) -> LlmSemanticPort:
    """The default SemanticPort. Options (keyword-only, one-to-one with TS's `LlmSemanticPortOptions`):

    - llm: the LlmPort used for NL normalization.
    - catalog: one catalog, or a per-tenant resolver `(tenant) -> catalog` (promotion adds Intents per tenant).
    - data_version: the data version of a query handle (sync or async).
    - describe_shape: column metadata for a parsed query ref (no rows). Return None for an unknown path (->
      raises). Omit to leave the port's describe_shape answering None.
    - rules: extra system-prompt rules (product-specific), rendered as "- ..." lines after the generic ones.
    - fallback_intent: Intent to fall back to (params { request: text }) when the model's answer fits no Intent.
      Without it, normalize raises SemanticNormalizeError.
    - output_locale: maps a locale tag to the "(locale)" label in the prompt. Default: `default_output_locale` (the
      tag itself when it is BCP-47-like, "und" otherwise, "en" when absent).
    - max_question_chars: rejects an NL question longer than this many characters before any LLM call
      (default 2000).
    - on_normalized: observation hook called after every successful NL normalization (both the matched-Intent
      and the fallback outcomes; never before a raise). Fail-open: an exception from the hook is swallowed.
    """
    return LlmSemanticPort(
        llm=llm,
        catalog=catalog,
        data_version=data_version,
        describe_shape=describe_shape,
        rules=rules,
        fallback_intent=fallback_intent,
        output_locale=output_locale,
        max_question_chars=max_question_chars,
        on_normalized=on_normalized,
    )
