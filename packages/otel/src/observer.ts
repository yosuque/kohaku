import type { ComposeErrorContext, ComposeObserver, ComposeTrace, TraceContext } from "@kohaku-ui/composer";
import {
  type Attributes,
  type Context,
  createTraceState,
  isSpanContextValid,
  context as otelContext,
  trace as otelTrace,
  type Span,
  type SpanContext,
  SpanStatusCode,
  type Tracer,
} from "@opentelemetry/api";

/**
 * Attribute key names emitted by createOtelComposeObserver's spans. The 5 `gen_ai.*` keys follow
 * OpenTelemetry's Generative AI semantic conventions
 * (https://opentelemetry.io/docs/specs/semconv/gen-ai/), which are still in "Development" status as of
 * this writing -- **the key spellings here are not a stability guarantee**, only this package's current
 * best-effort mapping. Every name is therefore independently overridable via
 * `createOtelComposeObserver({ attributes })`, so a future semconv rename (or a product's own convention)
 * does not require waiting on a kohaku release. The `kohaku.*` keys are this package's own, unaffiliated
 * with any external convention, and equally overridable for the same reason (an operator's collector /
 * dashboards may already expect different names).
 */
export interface OtelAttributeNames {
  operationName: string;
  providerName: string;
  requestModel: string;
  usageInputTokens: string;
  usageOutputTokens: string;
  tier: string;
  cache: string;
  intentHash: string;
  correlationId: string;
  durationMs: string;
}

/** createOtelComposeObserver's default attribute key names (see OtelAttributeNames' doc comment). */
export const DEFAULT_OTEL_ATTRIBUTE_NAMES: OtelAttributeNames = {
  operationName: "gen_ai.operation.name",
  providerName: "gen_ai.provider.name",
  requestModel: "gen_ai.request.model",
  usageInputTokens: "gen_ai.usage.input_tokens",
  usageOutputTokens: "gen_ai.usage.output_tokens",
  tier: "kohaku.tier",
  cache: "kohaku.cache",
  intentHash: "kohaku.intent_hash",
  correlationId: "kohaku.correlation_id",
  durationMs: "kohaku.duration_ms",
};

/** The span name onComposed / onError record under (a real compose attempt). */
const SPAN_NAME = "kohaku.compose";

/**
 * The span name onBudgetCheckError records under. Deliberately distinct from SPAN_NAME: a budget-check
 * failure is not a compose (generation continues normally around it -- see BudgetCheckErrorContext's doc
 * comment), so folding it into "kohaku.compose" would pollute the compose span count with an unrelated event
 * that carries no trace context (BudgetCheckErrorContext has no traceContext field to parent it under).
 */
const BUDGET_CHECK_SPAN_NAME = "kohaku.budget_check";

/**
 * `gen_ai.operation.name`'s value for a kohaku compose span. Fixed ("chat"): kohaku's L1/L2 generation is a
 * structured-output (schema-constrained) chat completion, the closest of GenAI semconv's enumerated
 * operation names. Set only when ComposeTrace.model is present -- an L0 fixed Spec or a cache hit never
 * calls an LLM at all, so no span for one ever asserts a gen_ai.* attribute for an operation it did not
 * perform.
 */
const GEN_AI_OPERATION_NAME = "chat";

export interface OtelComposeObserverOptions {
  /**
   * The @opentelemetry/api Tracer to record spans on. Defaults to
   * `trace.getTracer("@kohaku-ui/otel")` -- a no-op tracer when no SDK/TracerProvider is registered
   * globally, which is exactly the safe default for KOHAKU_OTEL unset/off: every call below still runs,
   * simply recording into a tracer that discards everything.
   */
  tracer?: Tracer;
  /** Overrides for one or more attribute key names (see OtelAttributeNames). Unspecified keys keep their default (DEFAULT_OTEL_ATTRIBUTE_NAMES). */
  attributes?: Partial<OtelAttributeNames>;
  /**
   * `gen_ai.provider.name`'s value (e.g. "anthropic", "openai", "ollama"). ComposeTrace carries only a
   * model id (LlmPort.modelId), never a provider name, so this package cannot derive it on its own --
   * pass the provider kohaku's LlmPort is actually configured with, or a function of the model id for a
   * host mixing providers. Omitted (default): the attribute is simply not set on any span.
   */
  providerName?: string | ((model: string) => string | undefined);
}

/**
 * Reconstructs a parent `Context` from a `ComposeTrace`/`ComposeErrorContext`'s `traceContext` (the
 * caller's own W3C trace, propagated via `ComposeOptions.traceContext` -- see TraceContext's doc comment
 * in @kohaku-ui/composer), so the span created here becomes a **child** of the caller's trace instead of
 * always starting a fresh root trace. Fail-open: a missing or malformed traceContext (defense in depth --
 * host-rest/host-mcp-apps already validate before ever setting this field) simply falls back to the
 * ambient active Context (today's un-parented behavior), never throws.
 */
function parentContextFrom(traceContext: TraceContext | undefined): Context {
  const active = otelContext.active();
  if (traceContext == null) return active;
  const parts = traceContext.traceparent.split("-");
  if (parts.length !== 4) return active;
  const [, traceId, spanId, flagsHex] = parts;
  const flags = Number.parseInt(flagsHex ?? "", 16);
  const spanContext: SpanContext = {
    traceId: traceId ?? "",
    spanId: spanId ?? "",
    traceFlags: Number.isNaN(flags) ? 0 : flags,
    isRemote: true,
    ...(traceContext.tracestate != null ? { traceState: createTraceState(traceContext.tracestate) } : {}),
  };
  if (!isSpanContextValid(spanContext)) return active;
  return otelTrace.setSpanContext(active, spanContext);
}

function providerNameFor(
  model: string | undefined,
  providerName: OtelComposeObserverOptions["providerName"],
): string | undefined {
  if (model == null || providerName == null) return undefined;
  return typeof providerName === "function" ? providerName(model) : providerName;
}

/** Builds the onComposed span's attributes from a ComposeTrace (see OtelAttributeNames' doc comment). */
function composedAttributes(
  trace: ComposeTrace,
  names: OtelAttributeNames,
  providerName: OtelComposeObserverOptions["providerName"],
): Attributes {
  const attrs: Attributes = {
    [names.tier]: trace.tier,
    [names.cache]: trace.cache,
    [names.intentHash]: trace.intent.hash,
    [names.durationMs]: trace.durationMs,
  };
  if (trace.correlationId != null) attrs[names.correlationId] = trace.correlationId;
  if (trace.model != null) {
    attrs[names.operationName] = GEN_AI_OPERATION_NAME;
    attrs[names.requestModel] = trace.model;
    const provider = providerNameFor(trace.model, providerName);
    if (provider != null) attrs[names.providerName] = provider;
  }
  if (trace.usage != null) {
    attrs[names.usageInputTokens] = trace.usage.inputTokens;
    attrs[names.usageOutputTokens] = trace.usage.outputTokens;
  }
  return attrs;
}

/** Builds the onError span's attributes from a ComposeErrorContext (only the fields it actually has). */
function errorAttributes(ctx: ComposeErrorContext, names: OtelAttributeNames): Attributes {
  const attrs: Attributes = {};
  if (ctx.intent != null) attrs[names.intentHash] = ctx.intent.hash;
  if (ctx.tier != null) attrs[names.tier] = ctx.tier;
  if (ctx.correlationId != null) attrs[names.correlationId] = ctx.correlationId;
  return attrs;
}

function endWithComposedStatus(span: Span, trace: ComposeTrace): void {
  span.setStatus(
    trace.fallback != null
      ? { code: SpanStatusCode.ERROR, message: trace.fallback.reason }
      : { code: SpanStatusCode.OK },
  );
  span.end();
}

/**
 * Creates a ComposeObserver that records each compose as an OpenTelemetry span (thin layer: no exporter /
 * SDK setup here -- that is left to the host process, see docs/user-guide.md's "Trace context / OTel"
 * section). Combine with a product's own observer via @kohaku-ui/composer's `composeObservers`.
 *
 * - `onComposed`: one span named "kohaku.compose" per delivered Spec, ending OK (or ERROR when
 *   trace.fallback is set -- a delivered-but-degraded Spec), with the gen_ai.* / kohaku.* attributes above.
 *   Its `startTime` is backdated by `trace.durationMs` so the span's length approximates the actual compose
 *   time instead of always reading ~0 (see composedAttributes' `durationMs` attribute for the exact figure).
 * - `onError`: one ERROR-status span (the exception recorded via span.recordException when it is an Error)
 *   for a genuine generation failure -- phase "hard" or "cache" only. Phases "fallback" (a
 *   degraded-but-delivered Spec) and "cancelled" (a caller abort, not a real failure -- see
 *   ComposeErrorContext's doc comment) create **no span here**: both outcomes still reach `onComposed` with
 *   their own single ERROR/OK span (a fallback compose always calls onComposed too, with `trace.fallback`
 *   set), so recording a second span in onError for either would double-count it -- e.g. one degraded
 *   delivery would otherwise produce two ERROR spans and roughly double the apparent fallback rate as soon
 *   as `KOHAKU_OTEL=1`. This mirrors the hosts' own lineage-recording skip for "cancelled" (a client
 *   disconnect must not inflate fallback-rate analytics either).
 * - `onBudgetCheckError`: **not a failure** (generation continues normally) -- recorded as its own span
 *   ("kohaku.budget_check", not "kohaku.compose" -- see BUDGET_CHECK_SPAN_NAME's doc comment) with a
 *   span event, never an ERROR status.
 *
 * Every hook is a plain function: any exception it throws (or a rejected Promise it returns) is swallowed
 * by @kohaku-ui/composer's own observer fire-and-forget wrapping (fireObserverHook, used by both a bare
 * ComposeObserver and composeObservers' per-observer isolation) -- this package relies on that existing
 * fail-open contract rather than duplicating try/catch here, so a broken/misconfigured Tracer (e.g. no
 * TracerProvider registered, or one that throws) never fails a compose.
 */
export function createOtelComposeObserver(options: OtelComposeObserverOptions = {}): ComposeObserver {
  const tracer = options.tracer ?? otelTrace.getTracer("@kohaku-ui/otel");
  const names: OtelAttributeNames = { ...DEFAULT_OTEL_ATTRIBUTE_NAMES, ...options.attributes };

  return {
    onComposed(trace) {
      // startTime is an approximation (Date.now() minus the already-elapsed durationMs), not the compose's
      // true wall-clock start -- close enough to keep the span's length representative in a trace waterfall
      // rather than always reading ~0, without threading a real start timestamp through ComposeTrace.
      const span = tracer.startSpan(
        SPAN_NAME,
        { startTime: Date.now() - trace.durationMs },
        parentContextFrom(trace.traceContext),
      );
      span.setAttributes(composedAttributes(trace, names, options.providerName));
      endWithComposedStatus(span, trace);
    },
    onError(ctx, error) {
      // "fallback" and "cancelled" are both already represented by onComposed's own span (see this
      // function's doc comment) -- recording a span here too would double-count them.
      if (ctx.phase === "fallback" || ctx.phase === "cancelled") return;
      const span = tracer.startSpan(SPAN_NAME, {}, parentContextFrom(ctx.traceContext));
      span.setAttributes(errorAttributes(ctx, names));
      if (error instanceof Error) span.recordException(error);
      const message = error instanceof Error ? error.message : (ctx.reason ?? ctx.phase);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      span.end();
    },
    onBudgetCheckError(ctx) {
      // This is not a failure notification (generation continues) -- see BudgetCheckErrorContext's doc
      // comment -- so it becomes a span event, never an ERROR status. BudgetCheckErrorContext carries no
      // traceContext (unlike ComposeTrace/ComposeErrorContext -- out of this package's scope to add), so
      // this always starts from the ambient active Context.
      const span = tracer.startSpan(BUDGET_CHECK_SPAN_NAME, {}, otelContext.active());
      span.setAttributes({ [names.tier]: ctx.tier, [names.intentHash]: ctx.intent.hash });
      span.addEvent("kohaku.budget_check_error");
      span.end();
    },
  };
}
