"""kohaku.llm — provider-agnostic generation contract (port of TS packages/llm).

A spec-independent standalone leaf. Whereas TS depends on zod + ai-sdk, the Python
version depends only on base pydantic (schemas) and, at generation time, a lazily
imported httpx (OpenAI-compatible HTTP).
"""

from .abort import AbortController, AbortError, AbortSignal, TimeoutAbortError
from .adapters.anthropic_native import create_anthropic_native_llm
from .adapters.gemini_native import create_gemini_native_llm
from .adapters.openai_compat import (
    ChatRequest,
    ChatResponse,
    ChatStreamChunk,
    ChatTransport,
    StreamingChatTransport,
    create_openai_compat_llm,
)
from .create import create_llm, create_llm_from_env
from .env import LlmConfig, LlmProvider, RetryPolicy, StructuredMode, resolve_llm_env
from .fake import FakeLlm, FakeLlmCall
from .port import (
    GenerateObjectRequest,
    GenerateObjectResult,
    GenerateTextRequest,
    GenerateTextResult,
    JsonSchema,
    LlmEffort,
    LlmError,
    LlmErrorCode,
    LlmPort,
    LlmUsage,
    OnPartial,
    PromptParts,
    SchemaInput,
    SchemaValidationError,
    StreamingLlmPort,
    is_validating_schema,
    schema_to_json_schema,
    supports_streaming,
    validate_against_schema,
)
from .retry import (
    ApiCallError,
    RetryDeps,
    default_retry_deps,
    is_retryable_provider_error,
    next_delay_ms,
    retryable_provider_error,
    with_provider_retry,
)

__all__ = [
    "AbortController",
    "AbortError",
    "AbortSignal",
    "ApiCallError",
    "ChatRequest",
    "ChatResponse",
    "ChatStreamChunk",
    "ChatTransport",
    "FakeLlm",
    "FakeLlmCall",
    "GenerateObjectRequest",
    "GenerateObjectResult",
    "GenerateTextRequest",
    "GenerateTextResult",
    "JsonSchema",
    "LlmConfig",
    "LlmEffort",
    "LlmError",
    "LlmErrorCode",
    "LlmPort",
    "LlmProvider",
    "LlmUsage",
    "OnPartial",
    "PromptParts",
    "RetryDeps",
    "RetryPolicy",
    "SchemaInput",
    "SchemaValidationError",
    "StreamingChatTransport",
    "StreamingLlmPort",
    "StructuredMode",
    "TimeoutAbortError",
    "create_anthropic_native_llm",
    "create_gemini_native_llm",
    "create_llm",
    "create_llm_from_env",
    "create_openai_compat_llm",
    "default_retry_deps",
    "is_retryable_provider_error",
    "is_validating_schema",
    "next_delay_ms",
    "resolve_llm_env",
    "retryable_provider_error",
    "schema_to_json_schema",
    "supports_streaming",
    "validate_against_schema",
    "with_provider_retry",
]
