"""Anthropic (claude) native adapter.

Corresponds to TS's `@ai-sdk/anthropic`, but Python uses the anthropic SDK directly. The skeleton (budget
expansion / signal/deadline / PROVIDER retry / auto fallback decision / prompt JSON / stream accumulation) is
centralized in `_base.StructuredLlmBase`, and this adapter implements only the provider-specific single call.

Structured output uses **strict forced tool-use** (GA as of Anthropic's structured outputs release): the call's
JSON Schema is defined as a single tool's `input_schema`, `strict: true` is set on that tool (constrained sampling
guarantees schema-conformant input), and the tool is forced via `tool_choice`. Anthropic's strict/JSON-Schema mode
does not accept the full JSON Schema vocabulary (no recursive `$ref`, no `minimum` / `maximum` / `multipleOf` /
`minLength` / `maxLength` / `pattern`, `minItems` only 0 or 1, `additionalProperties` must be `false`, `enum` values
must be primitives). Before sending, `_sanitize_for_anthropic` strips the unsupported keywords and folds each into
the node's `description` (same approach `@ai-sdk/anthropic`'s `sanitizeJsonSchema` takes and the one the TS side
already relies on through the AI SDK) so the schema stays representable without losing the constraint information
for the model to read. The model's tool_use block `input` (dict) is returned as the structured object and validated
against the **original, unsanitized** schema if it is a validating schema (validation is not weakened by
sanitization; only the wire schema sent to the provider is). On native failure (a missing tool_use block =
INVALID_OUTPUT, or a non-retryable PROVIDER such as a strict-schema-rejection 400), auto falls to the shared prompt
JSON fallback (the decision is identical to openai_compat).

Streaming accumulates tool-use's `input_json_delta` (partial_json) and reconstructs/notifies the cumulative partial
via `_base`'s `_accumulate_stream` (= reuse of `_parse_partial_json`).

The SDK (anthropic) uses the same **lazy import** style as the mcp extra. It is not required at module import; it is
imported only when building the default transport (a CONFIG error if not installed). Tests inject `AnthropicTransport` /
`AnthropicStreamTransport` to verify without calling the real API.
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Protocol

from ..abort import AbortSignal, TimeoutAbortError
from ..env import LlmConfig
from ..port import (
    GenerateObjectRequest,
    GenerateObjectResult,
    GenerateTextResult,
    LlmEffort,
    LlmError,
    LlmUsage,
    OnPartial,
    PromptParts,
    schema_to_json_schema,
)
from ..retry import ApiCallError, RetryDeps, default_retry_deps
from ._base import StructuredLlmBase, validate_native_object

# --- JSON Schema sanitization for Anthropic strict tool use / json_schema output -----------------------
#
# Mirrors `@ai-sdk/anthropic`'s `sanitizeJsonSchema` (the same transform the TS side already relies on via the
# AI SDK). Anthropic's structured-output JSON Schema subset does not accept these keywords; each one removed is
# folded into the node's `description` in English so the model still sees the constraint, and the caller still
# validates the final object against the original (unsanitized) schema.

_SUPPORTED_STRING_FORMATS = frozenset(
    {"date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"}
)

_DESCRIPTION_CONSTRAINT_KEYS = (
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
    "not",
)

_CAMEL_BOUNDARY = re.compile(r"[A-Z]")


def _format_constraint_name(key: str) -> str:
    """camelCase -> lowercase words separated by spaces (e.g. "minLength" -> "min length")."""
    return _CAMEL_BOUNDARY.sub(lambda m: " " + m.group(0).lower(), key)


def _format_constraint_value(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value)


def _constraint_description(schema: dict[str, Any]) -> str | None:
    """Build the English sentence a stripped node's constraints are folded into (`None` if there are none)."""
    descriptions: list[str] = []
    for key in _DESCRIPTION_CONSTRAINT_KEYS:
        value = schema.get(key)
        if value is None or value is False:
            continue
        descriptions.append(f"{_format_constraint_name(key)}: {_format_constraint_value(value)}")
    fmt = schema.get("format")
    if isinstance(fmt, str) and fmt not in _SUPPORTED_STRING_FORMATS:
        descriptions.append(f"format: {fmt}")
    if not descriptions:
        return None
    return "; ".join(descriptions) + "."


def _sanitize_definition(definition: Any) -> Any:
    """Sanitize a schema found in `properties` / `items` / `anyOf` / `$defs` etc. A bare `true`/`false` schema
    (no unsupported keywords possible) or a non-dict value passes through unchanged."""
    if isinstance(definition, bool) or not isinstance(definition, dict):
        return definition
    return _sanitize_for_anthropic(definition)


def _sanitize_for_anthropic(schema: dict[str, Any]) -> dict[str, Any]:
    """Reduce a JSON Schema node to the subset Anthropic's structured output / strict tool use accepts.

    Removed keywords: `minimum` / `maximum` / `exclusiveMinimum` / `exclusiveMaximum` / `multipleOf` (numeric),
    `minLength` / `maxLength` / `pattern` (string), `minItems` / `maxItems` / `uniqueItems` (array — Anthropic
    additionally restricts `minItems` to 0 or 1, which this function does not special-case since the value is
    dropped either way), `minProperties` / `maxProperties` / `not` (object/generic), and any `format` outside
    Anthropic's supported subset. Each removed keyword is appended (English, `"<name>: <value>."`) to the
    node's `description`. `additionalProperties` is forced to `false` on every object node (required by
    Anthropic). `$ref` nodes pass through untouched (recursion itself is a build-time property of the schema
    generator, not something this function can or should fix). Recurses into `properties` / `items` /
    `anyOf` / `oneOf` (folded into `anyOf`, matching `@ai-sdk/anthropic`) / `allOf` / `definitions` / `$defs`.
    """
    result: dict[str, Any] = {}
    ref = schema.get("$ref")
    if ref is not None:
        return {"$ref": ref}
    for key in ("$schema", "$id", "title", "description"):
        if schema.get(key) is not None:
            result[key] = schema[key]
    if "default" in schema:
        result["default"] = schema["default"]
    if "const" in schema:
        result["const"] = schema["const"]
    if schema.get("enum") is not None:
        result["enum"] = schema["enum"]
    if schema.get("type") is not None:
        result["type"] = schema["type"]
    any_of = schema.get("anyOf")
    one_of = schema.get("oneOf")
    if any_of is not None:
        result["anyOf"] = [_sanitize_definition(d) for d in any_of]
    elif one_of is not None:
        result["anyOf"] = [_sanitize_definition(d) for d in one_of]
    all_of = schema.get("allOf")
    if all_of is not None:
        result["allOf"] = [_sanitize_definition(d) for d in all_of]
    definitions = schema.get("definitions")
    if definitions is not None:
        result["definitions"] = {name: _sanitize_definition(d) for name, d in definitions.items()}
    defs = schema.get("$defs")
    if defs is not None:
        result["$defs"] = {name: _sanitize_definition(d) for name, d in defs.items()}
    if schema.get("type") == "object" or schema.get("properties") is not None:
        properties = schema.get("properties")
        if properties is not None:
            result["properties"] = {name: _sanitize_definition(d) for name, d in properties.items()}
        result["additionalProperties"] = False
        required = schema.get("required")
        if required is not None:
            result["required"] = required
    items = schema.get("items")
    if items is not None:
        result["items"] = (
            [_sanitize_definition(item) for item in items]
            if isinstance(items, list)
            else _sanitize_definition(items)
        )
    fmt = schema.get("format")
    if isinstance(fmt, str) and fmt in _SUPPORTED_STRING_FORMATS:
        result["format"] = fmt
    constraint_description = _constraint_description(schema)
    if constraint_description is not None:
        existing = result.get("description")
        result["description"] = (
            constraint_description if existing is None else f"{existing}\n{constraint_description}"
        )
    return result


@dataclass(frozen=True)
class AnthropicTool:
    """The single tool definition for strict forced tool-use.

    `input_schema` is the call's JSON Schema **after** `_sanitize_for_anthropic` (the wire-safe subset);
    validation of the returned object still happens against the original schema (see `_structured_once`).
    """

    name: str
    input_schema: dict[str, Any]


@dataclass(frozen=True)
class AnthropicRequest:
    """Input for a single messages call. If `tool` is None it is plain text; when set it is forced tool-use."""

    model: str
    system: str | None
    prompt: str
    temperature: float
    max_tokens: int
    tool: AnthropicTool | None
    prompt_parts: PromptParts | None = None
    """Port of TS's ai-sdk.ts `resolvePromptInput`'s input. Acted on only by `_user_content` below, and only
    when the config that produced this request has `prompt_cache` set."""
    effort: LlmEffort | None = None
    """Adaptive Reasoning effort (port of TS's `resolveProviderOptions`'s `{ anthropic: { effort } }`).
    Acted on only by `_tool_params`-adjacent request-building below: forwarded as `output_config={"effort":
    ...}` on the wire (the installed anthropic SDK's `OutputConfigParam`, confirmed against
    `types/output_config_param.py` — the plain per-call output option, not the differently-scoped, beta-gated
    system-message `effort` for mid-conversation changes). None when unset (no `output_config` key added at
    all, byte-identical to before this field existed)."""


@dataclass(frozen=True)
class AnthropicResponse:
    """The result of messages. With forced tool-use the body is in `tool_input`; for plain text it is in `text`."""

    tool_input: dict[str, Any] | None
    text: str
    usage: LlmUsage


class AnthropicTransport(Protocol):
    """The abstraction of a messages call. The default is the anthropic SDK. Tests stub this to control it."""

    async def __call__(
        self, req: AnthropicRequest, *, timeout_ms: float, signal: AbortSignal
    ) -> AnthropicResponse: ...


@dataclass(frozen=True)
class AnthropicStreamChunk:
    """One chunk of streaming messages.

    delta is the tool-use partial_json increment (to accumulate). usage is present only on the final chunk
    (the input_tokens from message_start and the output_tokens from message_delta, aggregated).
    """

    delta: str = ""
    usage: LlmUsage | None = None


class AnthropicStreamTransport(Protocol):
    """The abstraction of streaming messages (optional). If not injected, stream_object falls back to generate_object."""

    def stream(
        self, req: AnthropicRequest, *, timeout_ms: float, signal: AbortSignal
    ) -> AsyncIterator[AnthropicStreamChunk]: ...


class AnthropicNativeLlm(StructuredLlmBase):
    """An LlmPort implementation that calls the anthropic SDK using forced tool-use."""

    def __init__(
        self,
        config: LlmConfig,
        transport: AnthropicTransport,
        retry_deps: RetryDeps,
        stream_transport: AnthropicStreamTransport | None = None,
    ) -> None:
        super().__init__(config, retry_deps)
        self._transport = transport
        self._stream_transport = stream_transport

    def _can_stream_native(self) -> bool:
        return self._stream_transport is not None

    def _tool(self, req: GenerateObjectRequest) -> AnthropicTool:
        return AnthropicTool(
            name=req.schema_name if req.schema_name is not None else "response",
            input_schema=_sanitize_for_anthropic(schema_to_json_schema(req.schema)),
        )

    async def _structured_once(
        self,
        req: GenerateObjectRequest,
        max_output_tokens: int,
        signal: AbortSignal,
        deadline: float,
    ) -> GenerateObjectResult:
        config = self._config
        signal.throw_if_aborted()
        areq = AnthropicRequest(
            model=config.model,
            system=req.system,
            prompt=req.prompt,
            temperature=req.temperature if req.temperature is not None else config.temperature,
            max_tokens=max_output_tokens,
            tool=self._tool(req),
            prompt_parts=req.prompt_parts,
            effort=req.effort,
        )
        resp = await self._transport(areq, timeout_ms=self._remaining(deadline), signal=signal)
        if resp.tool_input is None:
            # Forced via tool_choice yet no tool_use block = invalid structured output.
            # In auto this triggers the prompt JSON fallback (same treatment as openai's structured 400).
            raise LlmError(
                "INVALID_OUTPUT",
                "forced tool-use response has no tool_use block",
                provider=config.provider,
                model_id=config.model,
            )
        obj = validate_native_object(req.schema, resp.tool_input, config)
        return GenerateObjectResult(object=obj, usage=resp.usage, model=config.model)

    async def _text_once(
        self,
        system: str | None,
        prompt: str,
        temperature: float,
        max_tokens: int,
        signal: AbortSignal,
        deadline: float,
        prompt_parts: PromptParts | None = None,
        effort: LlmEffort | None = None,
    ) -> GenerateTextResult:
        config = self._config
        signal.throw_if_aborted()
        areq = AnthropicRequest(
            model=config.model,
            system=system,
            prompt=prompt,
            temperature=temperature,
            max_tokens=max_tokens,
            tool=None,
            prompt_parts=prompt_parts,
            effort=effort,
        )
        resp = await self._transport(areq, timeout_ms=self._remaining(deadline), signal=signal)
        return GenerateTextResult(text=resp.text, usage=resp.usage)

    async def _stream_structured_once(
        self,
        req: GenerateObjectRequest,
        on_partial: OnPartial,
        max_output_tokens: int,
        signal: AbortSignal,
        deadline: float,
    ) -> GenerateObjectResult:
        config = self._config
        assert self._stream_transport is not None
        signal.throw_if_aborted()
        areq = AnthropicRequest(
            model=config.model,
            system=req.system,
            prompt=req.prompt,
            temperature=req.temperature if req.temperature is not None else config.temperature,
            max_tokens=max_output_tokens,
            tool=self._tool(req),
            prompt_parts=req.prompt_parts,
            effort=req.effort,
        )

        async def _deltas() -> AsyncIterator[tuple[str, LlmUsage | None]]:
            assert self._stream_transport is not None
            async for chunk in self._stream_transport.stream(
                areq, timeout_ms=self._remaining(deadline), signal=signal
            ):
                yield chunk.delta, chunk.usage

        return await self._accumulate_stream(req, on_partial, _deltas())


def create_anthropic_native_llm(
    config: LlmConfig,
    *,
    transport: AnthropicTransport | None = None,
    stream_transport: AnthropicStreamTransport | None = None,
    deps: RetryDeps | None = None,
) -> AnthropicNativeLlm:
    """Build the Anthropic native adapter. If `transport` is not given, lazily import the anthropic SDK.

    Test injection (passing a transport) does not require the SDK. On the default path, build the SDK-backed
    transport and stream transport (a CONFIG error if the SDK is not installed).
    """
    retry_deps = deps if deps is not None else default_retry_deps
    if transport is not None:
        return AnthropicNativeLlm(config, transport, retry_deps, stream_transport)
    resolved_transport, resolved_stream = _build_sdk_transports(config)
    resolved_stream = stream_transport if stream_transport is not None else resolved_stream
    return AnthropicNativeLlm(config, resolved_transport, retry_deps, resolved_stream)


def _build_sdk_transports(
    config: LlmConfig,
) -> tuple[AnthropicTransport, AnthropicStreamTransport]:
    try:
        import anthropic
    except ImportError as err:
        raise LlmError(
            "CONFIG",
            'provider "claude" requires the anthropic SDK. '
            "Run `pip install 'kohaku-ui[claude]'`.",
        ) from err

    # Disable the SDK's built-in exponential backoff (default max_retries=2). Retry is centralized in the llm
    # layer (with_provider_retry) (avoiding the double retry of SDK × llm; same as TS's maxRetries:0).
    client_kwargs: dict[str, Any] = {
        "api_key": config.api_key or "not-required",
        "max_retries": 0,
    }
    if config.base_url:
        client_kwargs["base_url"] = config.base_url
    client = anthropic.AsyncAnthropic(**client_kwargs)
    return _SdkTransport(client, config), _SdkStreamTransport(client, config)


def _user_content(req: AnthropicRequest, config: LlmConfig) -> str | list[dict[str, Any]]:
    """Resolves the `messages[0].content` value: the plain prompt string (conventional, always the case
    unless prompt caching is both enabled and applicable), or, when it applies, a 2-content-block list whose
    leading (`cacheable`) block carries `cache_control: {"type": "ephemeral"}`. Port of TS's
    `adapters/ai-sdk.ts` `resolvePromptInput` (this file is claude-only, so there is no provider check —
    every other TS-side no-op condition still applies here: gated on `config.prompt_cache`, `req.prompt_parts`
    being present with a non-empty `cacheable`, and the `cacheable + rest == prompt` invariant actually
    holding — a caller-side inconsistency falls back to the plain string rather than sending mismatched
    content to the model).
    """
    if not config.prompt_cache:
        return req.prompt
    parts = req.prompt_parts
    if parts is None or parts.cacheable == "" or parts.cacheable + parts.rest != req.prompt:
        return req.prompt
    content: list[dict[str, Any]] = [
        {"type": "text", "text": parts.cacheable, "cache_control": {"type": "ephemeral"}}
    ]
    if parts.rest != "":
        content.append({"type": "text", "text": parts.rest})
    return content


def _tool_params(req: AnthropicRequest) -> dict[str, Any]:
    """The strict forced tool-use request parameters (tools + tool_choice). If tool is None, an empty dict.

    `strict: True` asks Anthropic's GA structured-output constrained sampling to guarantee the tool's `input`
    conforms to `input_schema` (schema-conformant input is guaranteed at generation time rather than only
    checked after the fact), matching the effective behavior the TS side already gets from `@ai-sdk/anthropic`.
    """
    if req.tool is None:
        return {}
    return {
        "tools": [
            {
                "name": req.tool.name,
                "description": "Return the structured output for the call (this tool's input_schema).",
                "input_schema": req.tool.input_schema,
                "strict": True,
            }
        ],
        "tool_choice": {"type": "tool", "name": req.tool.name},
    }


def _output_config_params(req: AnthropicRequest) -> dict[str, Any]:
    """The `output_config` request parameter carrying Adaptive Reasoning `effort`. Empty dict when `effort`
    is unset — no `output_config` key at all, byte-identical to a call made before this field existed. See
    `AnthropicRequest.effort`'s doc for the exact wire shape and how it was verified against the installed
    anthropic SDK.
    """
    if req.effort is None:
        return {}
    return {"output_config": {"effort": req.effort}}


def _usage_of(usage: Any) -> LlmUsage:
    return LlmUsage(
        input_tokens=int(getattr(usage, "input_tokens", 0) or 0),
        output_tokens=int(getattr(usage, "output_tokens", 0) or 0),
    )


def _headers_of(err: Any) -> dict[str, str]:
    resp = getattr(err, "response", None)
    headers = getattr(resp, "headers", None)
    if headers is None:
        return {}
    try:
        return {str(k).lower(): str(v) for k, v in headers.items()}
    except Exception:  # noqa: BLE001 — a failure to read headers falls back to no Retry-After
        return {}


class _SdkTransport:
    """The default anthropic SDK-backed transport (non-streaming). Maps SDK errors to ApiCallError /
    TimeoutAbortError so they ride the llm layer's retry / classification."""

    def __init__(self, client: Any, config: LlmConfig) -> None:
        self._client = client
        self._config = config

    async def __call__(
        self, req: AnthropicRequest, *, timeout_ms: float, signal: AbortSignal
    ) -> AnthropicResponse:
        import anthropic

        signal.throw_if_aborted()
        params: dict[str, Any] = {
            "model": req.model,
            "max_tokens": req.max_tokens,
            "temperature": req.temperature,
            "messages": [{"role": "user", "content": _user_content(req, self._config)}],
            "timeout": max(0.1, timeout_ms / 1000.0),
            **_tool_params(req),
            **_output_config_params(req),
        }
        if req.system is not None:
            params["system"] = req.system
        try:
            message = await self._client.messages.create(**params)
        except anthropic.APITimeoutError as err:
            # Exceeding the remaining budget = timeout. Classify as ABORTED and do not retry.
            raise TimeoutAbortError(f"request timed out: {err}") from err
        except anthropic.APIStatusError as err:
            status = int(getattr(err, "status_code", 0) or 0)
            retryable = status == 429 or status >= 500
            raise ApiCallError(
                f"HTTP {status}: {str(err)[:200]}",
                is_retryable=retryable,
                status_code=status or None,
                response_headers=_headers_of(err),
            ) from err
        except anthropic.APIConnectionError as err:
            # Network errors are considered transient and made retryable.
            raise ApiCallError(str(err), is_retryable=True) from err
        return _to_response(message)


def _to_response(message: Any) -> AnthropicResponse:
    """Extract tool_use.input (structured) / text (plain) / usage from the SDK's Message."""
    tool_input: dict[str, Any] | None = None
    text_parts: list[str] = []
    for block in getattr(message, "content", []) or []:
        btype = getattr(block, "type", None)
        if btype == "tool_use":
            inp = getattr(block, "input", None)
            if isinstance(inp, dict):
                tool_input = inp
        elif btype == "text":
            text_parts.append(getattr(block, "text", "") or "")
    return AnthropicResponse(
        tool_input=tool_input,
        text="".join(text_parts),
        usage=_usage_of(getattr(message, "usage", None)),
    )


class _SdkStreamTransport:
    """The default anthropic SDK-backed streaming transport. Streams tool-use's partial_json as the delta to
    accumulate, and appends one aggregated usage chunk at the end."""

    def __init__(self, client: Any, config: LlmConfig) -> None:
        self._client = client
        self._config = config

    async def stream(
        self, req: AnthropicRequest, *, timeout_ms: float, signal: AbortSignal
    ) -> AsyncIterator[AnthropicStreamChunk]:
        import anthropic

        signal.throw_if_aborted()
        params: dict[str, Any] = {
            "model": req.model,
            "max_tokens": req.max_tokens,
            "temperature": req.temperature,
            "messages": [{"role": "user", "content": _user_content(req, self._config)}],
            "timeout": max(0.1, timeout_ms / 1000.0),
            **_tool_params(req),
            **_output_config_params(req),
        }
        if req.system is not None:
            params["system"] = req.system
        input_tokens = 0
        output_tokens = 0
        try:
            event_stream = await self._client.messages.create(**params, stream=True)
            async for event in event_stream:
                etype = getattr(event, "type", None)
                if etype == "message_start":
                    input_tokens = int(
                        getattr(getattr(event.message, "usage", None), "input_tokens", 0) or 0
                    )
                elif etype == "content_block_delta":
                    delta = getattr(event, "delta", None)
                    if getattr(delta, "type", None) == "input_json_delta":
                        partial = getattr(delta, "partial_json", "") or ""
                        if partial:
                            yield AnthropicStreamChunk(delta=partial)
                elif etype == "message_delta":
                    output_tokens = int(
                        getattr(getattr(event, "usage", None), "output_tokens", 0) or 0
                    )
            yield AnthropicStreamChunk(
                usage=LlmUsage(input_tokens=input_tokens, output_tokens=output_tokens)
            )
        except anthropic.APITimeoutError as err:
            raise TimeoutAbortError(f"request timed out: {err}") from err
        except anthropic.APIStatusError as err:
            status = int(getattr(err, "status_code", 0) or 0)
            retryable = status == 429 or status >= 500
            raise ApiCallError(
                f"HTTP {status}: {str(err)[:200]}",
                is_retryable=retryable,
                status_code=status or None,
                response_headers=_headers_of(err),
            ) from err
        except anthropic.APIConnectionError as err:
            raise ApiCallError(str(err), is_retryable=True) from err
