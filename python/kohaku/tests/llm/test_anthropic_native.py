"""Tests for the Anthropic (claude) native adapter.

Injects AnthropicTransport / AnthropicStreamTransport to control it deterministically (does not call the real API).
The skeleton (retry / auto fallback / budget / stream accumulation) is shared with openai_compat, so this focuses on
the provider-specific tool-use structuring / error mapping / fallback coordination / usage mapping.
"""

from __future__ import annotations

import asyncio
import builtins
from collections import deque
from collections.abc import AsyncIterator
from typing import Any

import pytest

from kohaku.llm import (
    GenerateObjectRequest,
    GenerateTextRequest,
    JsonSchema,
    LlmError,
    create_llm,
    supports_streaming,
)
from kohaku.llm.abort import AbortError, AbortSignal
from kohaku.llm.adapters.anthropic_native import (
    AnthropicRequest,
    AnthropicResponse,
    AnthropicStreamChunk,
    AnthropicTool,
    _sanitize_for_anthropic,
    _tool_params,
    _user_content,
    create_anthropic_native_llm,
)
from kohaku.llm.env import resolve_llm_env
from kohaku.llm.port import LlmUsage, PromptParts
from kohaku.llm.retry import ApiCallError, RetryDeps
from kohaku.registry import build_generation_schema, core_catalog, resolve_catalog

# claude default config (a key is set to avoid the warning) + default retry (max2 / init250).
# sleep is immediate, now is fixed (with slack before the deadline), randomness is centered.
CONFIG = resolve_llm_env({"KOHAKU_LLM_PROVIDER": "claude", "KOHAKU_LLM_API_KEY": "k"})


async def _noop_sleep(ms: float, signal: AbortSignal) -> None:
    return None


DEPS = RetryDeps(sleep=_noop_sleep, now=lambda: 0.0, random=lambda: 0.5)

_JSON_SCHEMA_REQ = GenerateObjectRequest(schema=JsonSchema({"type": "object"}), prompt="p")


class FakeAnthropicTransport:
    """A stub transport that routes to two channels based on the presence of a tool (structured = with tool / text = without tool)."""

    def __init__(self) -> None:
        self.object_script: deque[AnthropicResponse | BaseException] = deque()
        self.text_script: deque[AnthropicResponse | BaseException] = deque()
        self.object_repeat: BaseException | AnthropicResponse | None = None
        self.text_repeat: BaseException | AnthropicResponse | None = None
        self.object_calls: list[AnthropicRequest] = []
        self.text_calls: list[AnthropicRequest] = []

    async def __call__(
        self, req: AnthropicRequest, *, timeout_ms: float, signal: AbortSignal
    ) -> AnthropicResponse:
        if req.tool is not None:
            self.object_calls.append(req)
            if self.object_script:
                item = self.object_script.popleft()
            elif self.object_repeat is not None:
                item = self.object_repeat
            else:
                raise AssertionError("object script exhausted")
        else:
            self.text_calls.append(req)
            if self.text_script:
                item = self.text_script.popleft()
            elif self.text_repeat is not None:
                item = self.text_repeat
            else:
                raise AssertionError("text script exhausted")
        if isinstance(item, BaseException):
            raise item
        return item


def _ok_object(payload: dict[str, object]) -> AnthropicResponse:
    return AnthropicResponse(tool_input=payload, text="", usage=LlmUsage(input_tokens=1, output_tokens=2))


def _no_tool_block() -> AnthropicResponse:
    # Forced via tool_choice yet no tool_use = the trigger for INVALID_OUTPUT.
    return AnthropicResponse(tool_input=None, text="", usage=LlmUsage(input_tokens=1, output_tokens=0))


def _ok_text(text: str) -> AnthropicResponse:
    return AnthropicResponse(tool_input=None, text=text, usage=LlmUsage(input_tokens=0, output_tokens=0))


def _api_error(*, is_retryable: bool, status_code: int) -> ApiCallError:
    return ApiCallError(
        f"api {status_code}", is_retryable=is_retryable, status_code=status_code, response_headers={}
    )


def test_native_tool_use_success() -> None:
    async def run() -> None:
        transport = FakeAnthropicTransport()
        transport.object_script.append(_ok_object({"ok": True}))
        llm = create_anthropic_native_llm(CONFIG, transport=transport, deps=DEPS)
        r = await llm.generate_object(_JSON_SCHEMA_REQ)
        assert r.object == {"ok": True}
        assert r.model == CONFIG.model
        assert r.usage == LlmUsage(input_tokens=1, output_tokens=2)  # usage mapping
        assert len(transport.object_calls) == 1
        assert len(transport.text_calls) == 0
        # A forced tool-use request is built (the tool is the call's JSON Schema).
        assert transport.object_calls[0].tool is not None

    asyncio.run(run())


def test_missing_tool_block_falls_back_to_prompt_json() -> None:
    async def run() -> None:
        # When native ends with a missing tool_use block (INVALID_OUTPUT), auto goes to prompt JSON once.
        transport = FakeAnthropicTransport()
        transport.object_repeat = _no_tool_block()
        transport.text_script.append(_ok_text('{"ok": 1}'))
        llm = create_anthropic_native_llm(CONFIG, transport=transport, deps=DEPS)
        r = await llm.generate_object(_JSON_SCHEMA_REQ)
        assert r.object == {"ok": 1}
        assert len(transport.object_calls) == 1  # no retry
        assert len(transport.text_calls) == 1  # prompt fallback (no tool)

    asyncio.run(run())


def test_retryable_provider_retries_natively_without_prompt_fallback() -> None:
    async def run() -> None:
        transport = FakeAnthropicTransport()
        transport.object_script.extend(
            [
                _api_error(is_retryable=True, status_code=503),
                _api_error(is_retryable=True, status_code=529),
                _ok_object({"ok": True}),
            ]
        )
        llm = create_anthropic_native_llm(CONFIG, transport=transport, deps=DEPS)
        r = await llm.generate_object(_JSON_SCHEMA_REQ)
        assert r.object == {"ok": True}
        assert len(transport.object_calls) == 3  # 1 + 2 retries
        assert len(transport.text_calls) == 0

    asyncio.run(run())


def test_non_retryable_400_falls_back_to_prompt_json() -> None:
    async def run() -> None:
        transport = FakeAnthropicTransport()
        transport.object_repeat = _api_error(is_retryable=False, status_code=400)
        transport.text_script.append(_ok_text('{"ok": 2}'))
        llm = create_anthropic_native_llm(CONFIG, transport=transport, deps=DEPS)
        r = await llm.generate_object(_JSON_SCHEMA_REQ)
        assert r.object == {"ok": 2}
        assert len(transport.object_calls) == 1  # no retry
        assert len(transport.text_calls) == 1

    asyncio.run(run())


def test_retryable_provider_exhausted_fails_without_fallback() -> None:
    async def run() -> None:
        transport = FakeAnthropicTransport()
        transport.object_repeat = _api_error(is_retryable=True, status_code=429)
        llm = create_anthropic_native_llm(CONFIG, transport=transport, deps=DEPS)
        with pytest.raises(LlmError) as exc:
            await llm.generate_object(_JSON_SCHEMA_REQ)
        assert exc.value.code == "PROVIDER"
        assert len(transport.object_calls) == 3  # 1 + 2 retries
        assert len(transport.text_calls) == 0

    asyncio.run(run())


def test_aborted_propagates_without_retry_or_fallback() -> None:
    async def run() -> None:
        transport = FakeAnthropicTransport()
        transport.object_repeat = AbortError("abort")
        llm = create_anthropic_native_llm(CONFIG, transport=transport, deps=DEPS)
        with pytest.raises(LlmError) as exc:
            await llm.generate_object(_JSON_SCHEMA_REQ)
        assert exc.value.code == "ABORTED"
        assert len(transport.object_calls) == 1
        assert len(transport.text_calls) == 0

    asyncio.run(run())


def test_strict_mode_does_not_fall_back() -> None:
    async def run() -> None:
        cfg = resolve_llm_env(
            {"KOHAKU_LLM_PROVIDER": "claude", "KOHAKU_LLM_API_KEY": "k", "KOHAKU_LLM_STRUCTURED_MODE": "strict"}
        )
        transport = FakeAnthropicTransport()
        transport.object_repeat = _no_tool_block()  # under strict, INVALID_OUTPUT also fails immediately
        llm = create_anthropic_native_llm(cfg, transport=transport, deps=DEPS)
        with pytest.raises(LlmError) as exc:
            await llm.generate_object(_JSON_SCHEMA_REQ)
        assert exc.value.code == "INVALID_OUTPUT"
        assert len(transport.object_calls) == 1
        assert len(transport.text_calls) == 0

    asyncio.run(run())


def test_generate_text_maps_usage_and_retries() -> None:
    async def run() -> None:
        transport = FakeAnthropicTransport()
        transport.text_script.extend(
            [_api_error(is_retryable=True, status_code=500), _ok_text("hi")]
        )
        llm = create_anthropic_native_llm(CONFIG, transport=transport, deps=DEPS)
        r = await llm.generate_text(GenerateTextRequest(prompt="p"))
        assert r.text == "hi"
        assert len(transport.text_calls) == 2

    asyncio.run(run())


def test_generate_text_cancellation_is_not_wrapped() -> None:
    async def run() -> None:
        transport = FakeAnthropicTransport()
        transport.text_repeat = asyncio.CancelledError()
        llm = create_anthropic_native_llm(CONFIG, transport=transport, deps=DEPS)
        with pytest.raises(asyncio.CancelledError):
            await llm.generate_text(GenerateTextRequest(prompt="p"))
        assert len(transport.text_calls) == 1

    asyncio.run(run())


# --- stream_object contract (tool-use partial_json streaming) ----------------------


class FakeAnthropicStreamTransport:
    """A stub streaming transport that streams the tool-use partial_json sequence in order and appends aggregated usage at the end."""

    def __init__(self, deltas: list[str], usage: LlmUsage | None = None) -> None:
        self.deltas = deltas
        self.usage = usage if usage is not None else LlmUsage(input_tokens=3, output_tokens=4)
        self.calls: list[AnthropicRequest] = []

    async def stream(
        self, req: AnthropicRequest, *, timeout_ms: float, signal: AbortSignal
    ) -> AsyncIterator[AnthropicStreamChunk]:
        self.calls.append(req)
        for delta in self.deltas:
            yield AnthropicStreamChunk(delta=delta)
        yield AnthropicStreamChunk(usage=self.usage)


def test_stream_object_accumulates_partials_and_validates_final() -> None:
    async def run() -> None:
        seen: list[object] = []
        transport = FakeAnthropicTransport()
        stream_transport = FakeAnthropicStreamTransport(['{"components": [', '{"id": "a"}', "]}"])
        llm = create_anthropic_native_llm(
            CONFIG, transport=transport, stream_transport=stream_transport, deps=DEPS
        )
        assert supports_streaming(llm)
        result = await llm.stream_object(_JSON_SCHEMA_REQ, lambda p: seen.append(p))
        assert len(seen) >= 2
        assert seen[-1] == {"components": [{"id": "a"}]}
        assert result.object == {"components": [{"id": "a"}]}
        assert result.usage == stream_transport.usage
        assert len(stream_transport.calls) == 1
        assert stream_transport.calls[0].tool is not None  # the structured stream forces tool-use
        assert len(transport.text_calls) == 0
        assert len(transport.object_calls) == 0

    asyncio.run(run())


def test_stream_object_without_stream_transport_falls_back_to_generate_object() -> None:
    async def run() -> None:
        seen: list[object] = []
        transport = FakeAnthropicTransport()
        transport.object_script.append(_ok_object({"ok": 9}))
        llm = create_anthropic_native_llm(CONFIG, transport=transport, deps=DEPS)
        assert supports_streaming(llm)
        result = await llm.stream_object(_JSON_SCHEMA_REQ, lambda p: seen.append(p))
        assert result.object == {"ok": 9}
        assert seen == []  # no partials (fail-open)
        assert len(transport.object_calls) == 1

    asyncio.run(run())


def test_stream_object_falls_back_to_prompt_on_invalid_structured_output() -> None:
    async def run() -> None:
        # When the native structured stream ends in invalid JSON (INVALID_OUTPUT), auto falls back to prompt JSON
        # exactly once (same decision as generate_object).
        seen: list[object] = []
        transport = FakeAnthropicTransport()
        transport.text_script.append(_ok_text('{"ok": 7}'))
        stream_transport = FakeAnthropicStreamTransport(["not json at all"])
        llm = create_anthropic_native_llm(
            CONFIG, transport=transport, stream_transport=stream_transport, deps=DEPS
        )
        result = await llm.stream_object(_JSON_SCHEMA_REQ, lambda p: seen.append(p))
        assert result.object == {"ok": 7}
        assert len(stream_transport.calls) == 1
        assert len(transport.text_calls) == 1  # prompt fallback

    asyncio.run(run())


def test_create_llm_claude_missing_sdk_raises_config(monkeypatch: pytest.MonkeyPatch) -> None:
    # When anthropic is not installed, a CONFIG error points the way (the default path = SDK-backed transport).
    real_import = builtins.__import__

    def fake_import(name: str, *args: object, **kwargs: object) -> object:
        if name == "anthropic":
            raise ImportError("No module named 'anthropic'")
        return real_import(name, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(builtins, "__import__", fake_import)
    with pytest.raises(LlmError) as exc:
        create_llm(resolve_llm_env({"KOHAKU_LLM_PROVIDER": "claude", "KOHAKU_LLM_API_KEY": "k"}))
    assert exc.value.code == "CONFIG"
    assert "kohaku[claude]" in str(exc.value)


# --- strict tool use + schema sanitization (_sanitize_for_anthropic / _tool_params) ---------------------


def test_tool_params_sets_strict_true() -> None:
    tool = AnthropicTool(name="response", input_schema={"type": "object", "additionalProperties": False})
    req = AnthropicRequest(
        model="m", system=None, prompt="p", temperature=0, max_tokens=10, tool=tool
    )
    params = _tool_params(req)
    assert params["tools"][0]["strict"] is True
    assert params["tools"][0]["input_schema"] is tool.input_schema
    assert params["tool_choice"] == {"type": "tool", "name": "response"}


def test_tool_params_empty_without_tool() -> None:
    req = AnthropicRequest(model="m", system=None, prompt="p", temperature=0, max_tokens=10, tool=None)
    assert _tool_params(req) == {}


def test_sanitize_strips_numeric_and_string_constraints_into_description() -> None:
    schema = {
        "type": "object",
        "properties": {
            "n": {"type": "integer", "minimum": 1, "maximum": 10, "multipleOf": 2},
            "s": {"type": "string", "minLength": 3, "maxLength": 5, "pattern": "^[a-z]+$"},
        },
        "required": ["n", "s"],
    }
    sanitized = _sanitize_for_anthropic(schema)
    assert "minimum" not in sanitized["properties"]["n"]
    assert "maximum" not in sanitized["properties"]["n"]
    assert "multipleOf" not in sanitized["properties"]["n"]
    assert sanitized["properties"]["n"]["description"] == "minimum: 1; maximum: 10; multiple of: 2."
    assert "minLength" not in sanitized["properties"]["s"]
    assert "maxLength" not in sanitized["properties"]["s"]
    assert "pattern" not in sanitized["properties"]["s"]
    assert sanitized["properties"]["s"]["description"] == "min length: 3; max length: 5; pattern: ^[a-z]+$."
    # additionalProperties is forced to false on every object node.
    assert sanitized["additionalProperties"] is False
    assert sanitized["required"] == ["n", "s"]


def test_sanitize_prepends_constraint_description_to_existing_description() -> None:
    schema = {"type": "string", "description": "the id", "minLength": 1}
    sanitized = _sanitize_for_anthropic(schema)
    assert sanitized["description"] == "the id\nmin length: 1."


def test_sanitize_array_min_items_max_items_and_unique_items() -> None:
    schema = {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 5, "uniqueItems": True}
    sanitized = _sanitize_for_anthropic(schema)
    assert "minItems" not in sanitized
    assert "maxItems" not in sanitized
    assert "uniqueItems" not in sanitized
    assert sanitized["description"] == "min items: 1; max items: 5; unique items: true."


def test_sanitize_keeps_supported_string_format_and_folds_unsupported() -> None:
    supported = _sanitize_for_anthropic({"type": "string", "format": "date-time"})
    assert supported["format"] == "date-time"
    assert "description" not in supported

    unsupported = _sanitize_for_anthropic({"type": "string", "format": "byte"})
    assert "format" not in unsupported
    assert unsupported["description"] == "format: byte."


def test_sanitize_enum_const_and_type_pass_through() -> None:
    schema = {"type": "string", "enum": ["a", "b"], "const": "a"}
    sanitized = _sanitize_for_anthropic(schema)
    assert sanitized["enum"] == ["a", "b"]
    assert sanitized["const"] == "a"
    assert sanitized["type"] == "string"


def test_sanitize_ref_node_passes_through_untouched() -> None:
    # A $ref node is returned as-is (only the $ref itself); sibling keywords on a $ref node are dropped,
    # matching @ai-sdk/anthropic's sanitizeJsonSchema (the schema author is expected to put constraints on
    # the referenced definition, not alongside $ref).
    schema = {"$ref": "#/$defs/Foo", "description": "ignored"}
    assert _sanitize_for_anthropic(schema) == {"$ref": "#/$defs/Foo"}


def test_sanitize_recurses_into_any_of_one_of_all_of_defs_and_definitions() -> None:
    schema = {
        "$defs": {"Foo": {"type": "string", "minLength": 2}},
        "definitions": {"Bar": {"type": "string", "pattern": "x"}},
        "anyOf": [{"type": "integer", "minimum": 0}, {"type": "null"}],
        "oneOf": [{"type": "integer", "maximum": 0}],
        "allOf": [{"type": "object", "properties": {"a": {"type": "string"}}}],
    }
    sanitized = _sanitize_for_anthropic(schema)
    assert sanitized["$defs"]["Foo"]["description"] == "min length: 2."
    assert sanitized["definitions"]["Bar"]["description"] == "pattern: x."
    # oneOf is folded into anyOf (matching @ai-sdk/anthropic); a schema cannot carry both, so oneOf wins here
    # only when anyOf is absent — this schema has both, so anyOf (checked first) takes precedence.
    assert sanitized["anyOf"] == [{"type": "integer", "description": "minimum: 0."}, {"type": "null"}]
    # additionalProperties: false is forced on the allOf branch's own object node (its "a" property is a
    # plain string leaf, so it gets no additionalProperties of its own).
    assert sanitized["allOf"][0]["additionalProperties"] is False
    assert sanitized["allOf"][0]["properties"]["a"] == {"type": "string"}


def test_sanitize_items_array_form_and_object_form() -> None:
    object_form = _sanitize_for_anthropic({"type": "array", "items": {"type": "string", "minLength": 1}})
    assert object_form["items"]["description"] == "min length: 1."

    array_form = _sanitize_for_anthropic(
        {"type": "array", "items": [{"type": "string", "minLength": 1}, {"type": "integer"}]}
    )
    assert array_form["items"][0]["description"] == "min length: 1."
    assert array_form["items"][1] == {"type": "integer"}


def test_sanitize_bare_boolean_definition_passes_through() -> None:
    # A bare `true`/`false` schema (JSON Schema's "anything" / "nothing") cannot carry unsupported keywords,
    # so _sanitize_definition passes it through unchanged rather than crashing on dict-only access.
    schema = {"type": "object", "properties": {"free": True}}
    sanitized = _sanitize_for_anthropic(schema)
    assert sanitized["properties"]["free"] is True


def test_sanitize_forces_additional_properties_false_even_when_absent() -> None:
    sanitized = _sanitize_for_anthropic({"type": "object", "properties": {}})
    assert sanitized["additionalProperties"] is False


def test_sanitized_full_catalog_generation_schema_has_no_ref_nodes() -> None:
    """Locks in that the real L1 generation schema (the one actually sent to the provider) never contains a
    $ref node — i.e. no recursive schema reaches the Anthropic strict tool-use path. build_generation_schema
    constructs the schema as inline literals (no $ref/$defs at all; see registry/generation.py), so this is
    expected to hold, but is pinned here as a regression guard since Anthropic's structured output rejects
    recursive schemas outright."""
    catalog = resolve_catalog(core_catalog())
    generation = build_generation_schema(catalog, ["query://s/a", "query://s/b"])
    sanitized = _sanitize_for_anthropic(generation.jsonSchema)

    # Walk only the positions that are themselves *schema nodes* under the sanitizer's own recursion
    # (top / items / anyOf / allOf / $defs+definitions values / properties values) — NOT a "properties" map
    # itself, whose keys are property *names* (the catalog schema legitimately has a property literally named
    # "$ref", e.g. `{"properties": {"$ref": {"type": "string", "enum": [...]}}}` for a data binding, which is
    # not a JSON Schema $ref keyword and must not be flagged).
    def _assert_no_ref_marker(node: object) -> None:
        if not isinstance(node, dict):
            return
        assert "$ref" not in node, f"unexpected $ref keyword in sanitized schema node: {node}"
        for value in (node.get("properties") or {}).values():
            _assert_no_ref_marker(value)
        for value in (node.get("$defs") or {}).values():
            _assert_no_ref_marker(value)
        for value in (node.get("definitions") or {}).values():
            _assert_no_ref_marker(value)
        items = node.get("items")
        if isinstance(items, list):
            for item in items:
                _assert_no_ref_marker(item)
        elif items is not None:
            _assert_no_ref_marker(items)
        for key in ("anyOf", "allOf"):
            for entry in node.get(key) or []:
                _assert_no_ref_marker(entry)

    _assert_no_ref_marker(sanitized)


def test_generate_object_sends_sanitized_schema_to_transport() -> None:
    """End-to-end (through the adapter, not calling _sanitize_for_anthropic directly): a schema with
    Anthropic-unsupported keywords is sanitized before being handed to the transport as the tool's
    input_schema, and the description carries the removed constraints in English."""

    async def run() -> None:
        transport = FakeAnthropicTransport()
        transport.object_script.append(_ok_object({"name": "ab"}))
        req = GenerateObjectRequest(
            schema=JsonSchema(
                {
                    "type": "object",
                    "properties": {"name": {"type": "string", "minLength": 1, "maxLength": 10}},
                    "required": ["name"],
                }
            ),
            prompt="p",
            schema_name="named_thing",
        )
        llm = create_anthropic_native_llm(CONFIG, transport=transport, deps=DEPS)
        r = await llm.generate_object(req)
        assert r.object == {"name": "ab"}
        sent_schema: dict[str, Any] = transport.object_calls[0].tool.input_schema  # type: ignore[union-attr]
        assert "minLength" not in sent_schema["properties"]["name"]
        assert "maxLength" not in sent_schema["properties"]["name"]
        assert sent_schema["properties"]["name"]["description"] == "min length: 1; max length: 10."
        assert sent_schema["additionalProperties"] is False

    asyncio.run(run())


def test_strict_schema_rejection_400_falls_back_to_prompt_json() -> None:
    """A strict/JSON-Schema-mode rejection surfaces as APIStatusError(400) from the SDK (same shape as any
    other structured-output 400), which _SdkTransport maps to a non-retryable ApiCallError; the shared
    orchestration in _base then treats it exactly like any other INVALID_OUTPUT-class failure and retries once
    via the full-text prompt-JSON fallback (existing failure path — no new mapping was needed for strict)."""

    async def run() -> None:
        transport = FakeAnthropicTransport()
        transport.object_repeat = _api_error(is_retryable=False, status_code=400)
        transport.text_script.append(_ok_text('{"name": "ab"}'))
        llm = create_anthropic_native_llm(CONFIG, transport=transport, deps=DEPS)
        r = await llm.generate_object(_JSON_SCHEMA_REQ)
        assert r.object == {"name": "ab"}
        assert len(transport.object_calls) == 1
        assert len(transport.text_calls) == 1

    asyncio.run(run())


# --- Opt-in prompt caching (LlmConfig.prompt_cache / PromptParts / _user_content) ------------------------

PROMPT_CACHE_CONFIG = resolve_llm_env(
    {"KOHAKU_LLM_PROVIDER": "claude", "KOHAKU_LLM_API_KEY": "k", "KOHAKU_LLM_PROMPT_CACHE": "1"}
)


def test_prompt_cache_defaults_off() -> None:
    assert CONFIG.prompt_cache is False
    assert PROMPT_CACHE_CONFIG.prompt_cache is True


def test_user_content_default_off_returns_plain_prompt_even_with_prompt_parts() -> None:
    areq = AnthropicRequest(
        model="m",
        system=None,
        prompt="STATICREST",
        temperature=0,
        max_tokens=100,
        tool=None,
        prompt_parts=PromptParts(cacheable="STATIC", rest="REST"),
    )
    assert _user_content(areq, CONFIG) == "STATICREST"


def test_user_content_prompt_cache_on_but_no_prompt_parts_returns_plain_prompt() -> None:
    areq = AnthropicRequest(
        model="m", system=None, prompt="just a string", temperature=0, max_tokens=100, tool=None
    )
    assert _user_content(areq, PROMPT_CACHE_CONFIG) == "just a string"


def test_user_content_prompt_cache_on_splits_into_two_blocks_with_cache_control_on_the_leading_one() -> None:
    areq = AnthropicRequest(
        model="m",
        system=None,
        prompt="STATICREST",
        temperature=0,
        max_tokens=100,
        tool=None,
        prompt_parts=PromptParts(cacheable="STATIC", rest="REST"),
    )
    assert _user_content(areq, PROMPT_CACHE_CONFIG) == [
        {"type": "text", "text": "STATIC", "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": "REST"},
    ]


def test_user_content_empty_rest_sends_only_one_cached_block() -> None:
    areq = AnthropicRequest(
        model="m",
        system=None,
        prompt="STATIC",
        temperature=0,
        max_tokens=100,
        tool=None,
        prompt_parts=PromptParts(cacheable="STATIC", rest=""),
    )
    content = _user_content(areq, PROMPT_CACHE_CONFIG)
    assert content == [{"type": "text", "text": "STATIC", "cache_control": {"type": "ephemeral"}}]


def test_user_content_inconsistent_prompt_parts_falls_back_to_plain_prompt() -> None:
    """cacheable + rest != prompt (a caller-side bug) must not silently send mismatched content."""
    areq = AnthropicRequest(
        model="m",
        system=None,
        prompt="ACTUAL",
        temperature=0,
        max_tokens=100,
        tool=None,
        prompt_parts=PromptParts(cacheable="NOT", rest="MATCHING"),
    )
    assert _user_content(areq, PROMPT_CACHE_CONFIG) == "ACTUAL"


def test_generate_object_and_generate_text_thread_prompt_parts_through_to_anthropic_request() -> None:
    """GenerateObjectRequest/GenerateTextRequest.prompt_parts reaches the AnthropicRequest the transport
    receives (the plumbing _user_content itself is unit-tested above; this confirms the wiring end to end)."""

    async def run() -> None:
        transport = FakeAnthropicTransport()
        transport.object_repeat = _ok_object({"ok": True})
        transport.text_repeat = _ok_text("hello")
        llm = create_anthropic_native_llm(PROMPT_CACHE_CONFIG, transport=transport, deps=DEPS)

        parts = PromptParts(cacheable="STATIC", rest="REST")
        await llm.generate_object(
            GenerateObjectRequest(schema=JsonSchema({"type": "object"}), prompt="STATICREST", prompt_parts=parts)
        )
        assert transport.object_calls[0].prompt_parts == parts

        await llm.generate_text(GenerateTextRequest(prompt="STATICREST", prompt_parts=parts))
        assert transport.text_calls[0].prompt_parts == parts

    asyncio.run(run())
