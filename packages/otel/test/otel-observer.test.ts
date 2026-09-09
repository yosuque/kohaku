import type {
  BudgetCheckErrorContext,
  ComposeErrorContext,
  ComposeTrace,
  TraceContext,
} from "@kohaku-ui/composer";
import { composeObservers } from "@kohaku-ui/composer";
import type { CanonicalIntent } from "@kohaku-ui/spec-core";
import {
  type Attributes,
  type Context,
  type Exception,
  context as otelContext,
  trace as otelTrace,
  type Span,
  type SpanContext,
  type SpanOptions,
  SpanStatusCode,
  type Tracer,
} from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { createOtelComposeObserver, DEFAULT_OTEL_ATTRIBUTE_NAMES } from "../src/index.js";

/**
 * A minimal @opentelemetry/api-conformant in-memory tracer ("InMemory tracer equivalent" per this repo's
 * verification-discipline instructions): records every started span (attributes/status/events/end) in an
 * inspectable array, without depending on the real @opentelemetry/sdk-trace-base package (this package
 * only ever depends on @opentelemetry/api at runtime -- see package.json).
 */
class FakeSpan implements Span {
  name: string;
  readonly parentContext: Context | undefined;
  readonly options: SpanOptions | undefined;
  attributes: Attributes = {};
  events: Array<{ name: string; attributes?: Attributes }> = [];
  status: { code: SpanStatusCode; message?: string } = { code: SpanStatusCode.UNSET };
  exceptions: Exception[] = [];
  ended = false;

  constructor(name: string, parentContext: Context | undefined, options?: SpanOptions) {
    this.name = name;
    this.parentContext = parentContext;
    this.options = options;
  }
  spanContext(): SpanContext {
    return { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 };
  }
  setAttribute(key: string, value: Attributes[string]): this {
    this.attributes[key] = value;
    return this;
  }
  setAttributes(attributes: Attributes): this {
    Object.assign(this.attributes, attributes);
    return this;
  }
  addEvent(name: string, attributesOrStartTime?: Attributes | number): this {
    if (attributesOrStartTime != null && typeof attributesOrStartTime === "object") {
      this.events.push({ name, attributes: attributesOrStartTime });
    } else {
      this.events.push({ name });
    }
    return this;
  }
  addLink(): this {
    return this;
  }
  addLinks(): this {
    return this;
  }
  setStatus(status: { code: SpanStatusCode; message?: string }): this {
    this.status = status;
    return this;
  }
  updateName(name: string): this {
    this.name = name;
    return this;
  }
  end(): void {
    this.ended = true;
  }
  isRecording(): boolean {
    return !this.ended;
  }
  recordException(exception: Exception): void {
    this.exceptions.push(exception);
  }
}

class FakeTracer implements Tracer {
  readonly spans: FakeSpan[] = [];
  startSpan(name: string, options?: SpanOptions, context?: Context): Span {
    const span = new FakeSpan(name, context, options);
    this.spans.push(span);
    return span;
  }
  // Not exercised by createOtelComposeObserver (it only ever calls startSpan) -- `any` keeps this fake's
  // implementation of Tracer's 3 overloaded call signatures trivial.
  startActiveSpan(..._args: any[]): any {
    throw new Error("FakeTracer.startActiveSpan is not used by createOtelComposeObserver");
  }
}

const INTENT: CanonicalIntent = {
  canonical: "sales.trend",
  params: {},
  hash: "intent-hash-abc",
};

function baseTrace(overrides: Partial<ComposeTrace> = {}): ComposeTrace {
  return {
    input: { kind: "intent" },
    intent: INTENT,
    refs: [],
    dataVersion: "v1",
    cacheKey: "key-1",
    cache: "miss",
    tier: "L1",
    attempts: [],
    durationMs: 42,
    ...overrides,
  };
}

const SAMPLE_TRACE_CONTEXT: TraceContext = {
  traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
};

const SAMPLE_TRACE_CONTEXT_WITH_STATE: TraceContext = {
  ...SAMPLE_TRACE_CONTEXT,
  tracestate: "vendor1=value1,vendor2=value2",
};

describe("createOtelComposeObserver", () => {
  it("records a span with the 5 gen_ai.* attributes + kohaku.* attributes when a model was used", () => {
    const tracer = new FakeTracer();
    const observer = createOtelComposeObserver({ tracer, providerName: "anthropic" });
    const trace = baseTrace({
      model: "claude-x",
      usage: { inputTokens: 10, outputTokens: 20 },
      correlationId: "req-1",
    });
    observer.onComposed?.(trace, {} as never);

    expect(tracer.spans).toHaveLength(1);
    const span = tracer.spans[0]!;
    expect(span.name).toBe("kohaku.compose");
    expect(span.attributes).toEqual({
      [DEFAULT_OTEL_ATTRIBUTE_NAMES.operationName]: "chat",
      [DEFAULT_OTEL_ATTRIBUTE_NAMES.providerName]: "anthropic",
      [DEFAULT_OTEL_ATTRIBUTE_NAMES.requestModel]: "claude-x",
      [DEFAULT_OTEL_ATTRIBUTE_NAMES.usageInputTokens]: 10,
      [DEFAULT_OTEL_ATTRIBUTE_NAMES.usageOutputTokens]: 20,
      [DEFAULT_OTEL_ATTRIBUTE_NAMES.tier]: "L1",
      [DEFAULT_OTEL_ATTRIBUTE_NAMES.cache]: "miss",
      [DEFAULT_OTEL_ATTRIBUTE_NAMES.intentHash]: "intent-hash-abc",
      [DEFAULT_OTEL_ATTRIBUTE_NAMES.correlationId]: "req-1",
      [DEFAULT_OTEL_ATTRIBUTE_NAMES.durationMs]: 42,
    });
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.ended).toBe(true);
  });

  it("omits every gen_ai.* attribute when no model was used (an L0 fixed Spec / cache hit)", () => {
    const tracer = new FakeTracer();
    const observer = createOtelComposeObserver({ tracer });
    observer.onComposed?.(baseTrace({ tier: "L0", cache: "hit" }), {} as never);

    const span = tracer.spans[0]!;
    for (const key of [
      DEFAULT_OTEL_ATTRIBUTE_NAMES.operationName,
      DEFAULT_OTEL_ATTRIBUTE_NAMES.providerName,
      DEFAULT_OTEL_ATTRIBUTE_NAMES.requestModel,
      DEFAULT_OTEL_ATTRIBUTE_NAMES.usageInputTokens,
      DEFAULT_OTEL_ATTRIBUTE_NAMES.usageOutputTokens,
    ]) {
      expect(span.attributes[key]).toBeUndefined();
    }
    expect(span.attributes[DEFAULT_OTEL_ATTRIBUTE_NAMES.tier]).toBe("L0");
  });

  it("marks a fallback-delivered trace's span ERROR with the fallback reason", () => {
    const tracer = new FakeTracer();
    const observer = createOtelComposeObserver({ tracer });
    observer.onComposed?.(baseTrace({ fallback: { reason: "l1_invalid" } }), {} as never);

    const span = tracer.spans[0]!;
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: "l1_invalid" });
  });

  it("backdates the span's startTime by trace.durationMs so its length approximates the real compose time", () => {
    const tracer = new FakeTracer();
    const observer = createOtelComposeObserver({ tracer });
    const before = Date.now();
    observer.onComposed?.(baseTrace({ durationMs: 250 }), {} as never);
    const after = Date.now();

    const span = tracer.spans[0]!;
    const startTime = span.options?.startTime as number;
    expect(startTime).toBeDefined();
    // startTime = (a Date.now() sampled inside onComposed) - durationMs; bracket it against timestamps taken
    // immediately before/after the call so this does not depend on the exact instant onComposed reads.
    expect(startTime).toBeGreaterThanOrEqual(before - 250);
    expect(startTime).toBeLessThanOrEqual(after - 250);
  });

  it("computes providerName via a function of the model id", () => {
    const tracer = new FakeTracer();
    const observer = createOtelComposeObserver({ tracer, providerName: (model) => `provider-of-${model}` });
    observer.onComposed?.(baseTrace({ model: "claude-x" }), {} as never);

    const span = tracer.spans[0]!;
    expect(span.attributes[DEFAULT_OTEL_ATTRIBUTE_NAMES.providerName]).toBe("provider-of-claude-x");
  });

  it("overrides attribute key names via the `attributes` option", () => {
    const tracer = new FakeTracer();
    const observer = createOtelComposeObserver({ tracer, attributes: { tier: "custom.tier" } });
    observer.onComposed?.(baseTrace(), {} as never);

    const span = tracer.spans[0]!;
    expect(span.attributes["custom.tier"]).toBe("L1");
    expect(span.attributes[DEFAULT_OTEL_ATTRIBUTE_NAMES.tier]).toBeUndefined();
    // Every other default name is untouched by a partial override.
    expect(span.attributes[DEFAULT_OTEL_ATTRIBUTE_NAMES.cache]).toBe("miss");
  });

  it("restores the caller's traceparent as the span's parent context (child-of, not a fresh root)", () => {
    const tracer = new FakeTracer();
    const observer = createOtelComposeObserver({ tracer });
    observer.onComposed?.(baseTrace({ traceContext: SAMPLE_TRACE_CONTEXT }), {} as never);

    const span = tracer.spans[0]!;
    expect(span.parentContext).toBeDefined();
    const restored = otelTrace.getSpanContext(span.parentContext!);
    expect(restored?.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(restored?.spanId).toBe("b7ad6b7169203331");
    expect(restored?.isRemote).toBe(true);
  });

  it("passes tracestate through createTraceState onto the restored parent SpanContext", () => {
    const tracer = new FakeTracer();
    const observer = createOtelComposeObserver({ tracer });
    observer.onComposed?.(baseTrace({ traceContext: SAMPLE_TRACE_CONTEXT_WITH_STATE }), {} as never);

    const span = tracer.spans[0]!;
    const restored = otelTrace.getSpanContext(span.parentContext!);
    expect(restored?.traceState?.get("vendor1")).toBe("value1");
    expect(restored?.traceState?.get("vendor2")).toBe("value2");
  });

  it("falls back to the ambient context on a malformed traceContext (fail-open, never throws)", () => {
    const tracer = new FakeTracer();
    const observer = createOtelComposeObserver({ tracer });
    expect(() =>
      observer.onComposed?.(
        baseTrace({ traceContext: { traceparent: "not-a-valid-traceparent" } }),
        {} as never,
      ),
    ).not.toThrow();

    const span = tracer.spans[0]!;
    // No SpanContext could be restored, so the parent context carries none.
    expect(otelTrace.getSpanContext(span.parentContext ?? otelContext.active())).toBeUndefined();
  });

  it("onError records an ERROR-status span with the exception attached, for a hard failure", () => {
    const tracer = new FakeTracer();
    const observer = createOtelComposeObserver({ tracer });
    const ctx: ComposeErrorContext = { phase: "hard", input: { kind: "intent" }, intent: INTENT };
    const error = new Error("normalize failed");
    observer.onError?.(ctx, error);

    const span = tracer.spans[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("normalize failed");
    expect(span.exceptions).toEqual([error]);
    expect(span.ended).toBe(true);
  });

  it("onError restores the caller's traceparent as the span's parent context, same as onComposed", () => {
    const tracer = new FakeTracer();
    const observer = createOtelComposeObserver({ tracer });
    const ctx: ComposeErrorContext = {
      phase: "hard",
      input: { kind: "intent" },
      intent: INTENT,
      traceContext: SAMPLE_TRACE_CONTEXT,
    };
    observer.onError?.(ctx, new Error("normalize failed"));

    const span = tracer.spans[0]!;
    expect(span.parentContext).toBeDefined();
    const restored = otelTrace.getSpanContext(span.parentContext!);
    expect(restored?.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(restored?.spanId).toBe("b7ad6b7169203331");
    expect(restored?.isRemote).toBe(true);
  });

  it("onError also records an ERROR-status span for a cache-lookup failure (phase: cache)", () => {
    const tracer = new FakeTracer();
    const observer = createOtelComposeObserver({ tracer });
    const ctx: ComposeErrorContext = { phase: "cache", input: { kind: "intent" }, intent: INTENT };
    observer.onError?.(ctx, new Error("cache backend unavailable"));

    const span = tracer.spans[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.ended).toBe(true);
  });

  it("onError records NO span for phase:fallback -- onComposed's own span already represents the degraded delivery", () => {
    const tracer = new FakeTracer();
    const observer = createOtelComposeObserver({ tracer });
    const ctx: ComposeErrorContext = {
      phase: "fallback",
      input: { kind: "intent" },
      intent: INTENT,
      tier: "L1",
      reason: "l1_invalid",
    };
    observer.onError?.(ctx, new Error("l1 generation invalid"));

    // A degraded-but-delivered compose always also calls onComposed (with trace.fallback set), whose own
    // ERROR span already reflects this outcome -- recording a second span here would double-count it.
    expect(tracer.spans).toHaveLength(0);
  });

  it("onError records NO span for phase:cancelled -- a caller abort is not a failure and is already represented by onComposed", () => {
    const tracer = new FakeTracer();
    const observer = createOtelComposeObserver({ tracer });
    const ctx: ComposeErrorContext = {
      phase: "cancelled",
      input: { kind: "intent" },
      intent: INTENT,
      tier: "L1",
    };
    observer.onError?.(ctx, undefined);

    expect(tracer.spans).toHaveLength(0);
  });

  it("onBudgetCheckError records its own span (kohaku.budget_check, not kohaku.compose) with a span event, never an ERROR status", () => {
    const tracer = new FakeTracer();
    const observer = createOtelComposeObserver({ tracer });
    const ctx: BudgetCheckErrorContext = {
      input: { kind: "intent" },
      intent: INTENT,
      cacheKey: "key-1",
      tier: "L1",
    };
    observer.onBudgetCheckError?.(ctx, new Error("budget hook threw"));

    const span = tracer.spans[0]!;
    expect(span.name).toBe("kohaku.budget_check");
    expect(span.events.map((e) => e.name)).toContain("kohaku.budget_check_error");
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.ended).toBe(true);
  });

  describe("fail-open", () => {
    it("a broken Tracer (startSpan throws) never breaks the caller when combined via composeObservers", () => {
      const brokenTracer: Tracer = {
        startSpan() {
          throw new Error("no TracerProvider / broken exporter");
        },
        startActiveSpan(..._args: any[]): any {
          throw new Error("unused");
        },
      };
      const otelObserver = createOtelComposeObserver({ tracer: brokenTracer });
      let otherCalled = 0;
      const merged = composeObservers(otelObserver, { onComposed: () => void otherCalled++ });

      // composeObservers isolates each observer's hook via fireObserverHook, so calling the merged
      // onComposed synchronously must not throw even though the otel observer's underlying call does,
      // and the other (working) observer in the list must still run.
      expect(() => merged.onComposed?.(baseTrace(), {} as never)).not.toThrow();
      expect(otherCalled).toBe(1);
    });
  });
});
