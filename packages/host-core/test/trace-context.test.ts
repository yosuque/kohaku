import { describe, expect, it } from "vitest";
import { parseTraceContext, TRACEPARENT_RE } from "../src/trace-context.js";

const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const ALL_ZERO_TRACE_ID = "00-00000000000000000000000000000000-00f067aa0ba902b7-01";
const ALL_ZERO_PARENT_ID = "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01";
const UPPERCASE_HEX = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01";
const VERSION_FF = "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const TRACE_ID_TOO_SHORT = "00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01";
const PARENT_ID_TOO_LONG = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7ff-01";
const MISSING_FLAGS_FIELD = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7";

describe("TRACEPARENT_RE", () => {
  it("accepts a strictly W3C-formatted traceparent", () => {
    expect(TRACEPARENT_RE.test(VALID)).toBe(true);
  });

  it("rejects an all-zero trace-id (invalid per the W3C spec)", () => {
    expect(TRACEPARENT_RE.test(ALL_ZERO_TRACE_ID)).toBe(false);
  });

  it("rejects an all-zero parent-id (invalid per the W3C spec)", () => {
    expect(TRACEPARENT_RE.test(ALL_ZERO_PARENT_ID)).toBe(false);
  });

  it("rejects uppercase hex", () => {
    expect(TRACEPARENT_RE.test(UPPERCASE_HEX)).toBe(false);
  });

  it("rejects a version byte other than 00", () => {
    expect(TRACEPARENT_RE.test(VERSION_FF)).toBe(false);
  });

  it("rejects a trace-id shorter than 32 hex characters", () => {
    expect(TRACEPARENT_RE.test(TRACE_ID_TOO_SHORT)).toBe(false);
  });

  it("rejects a parent-id longer than 16 hex characters", () => {
    expect(TRACEPARENT_RE.test(PARENT_ID_TOO_LONG)).toBe(false);
  });

  it("rejects a traceparent missing the flags field", () => {
    expect(TRACEPARENT_RE.test(MISSING_FLAGS_FIELD)).toBe(false);
  });
});

describe("parseTraceContext", () => {
  it("returns a TraceContext for a valid traceparent with no tracestate", () => {
    expect(parseTraceContext(VALID)).toEqual({ traceparent: VALID });
  });

  it("returns a TraceContext with tracestate when both are valid", () => {
    expect(parseTraceContext(VALID, "vendor=value")).toEqual({
      traceparent: VALID,
      tracestate: "vendor=value",
    });
  });

  it("returns undefined for an all-zero trace-id", () => {
    expect(parseTraceContext(ALL_ZERO_TRACE_ID)).toBeUndefined();
  });

  it("returns undefined for an all-zero parent-id", () => {
    expect(parseTraceContext(ALL_ZERO_PARENT_ID)).toBeUndefined();
  });

  it("returns undefined for uppercase hex", () => {
    expect(parseTraceContext(UPPERCASE_HEX)).toBeUndefined();
  });

  it("returns undefined for a version byte other than 00", () => {
    expect(parseTraceContext(VERSION_FF)).toBeUndefined();
  });

  it("returns undefined for wrong segment lengths", () => {
    expect(parseTraceContext(TRACE_ID_TOO_SHORT)).toBeUndefined();
    expect(parseTraceContext(PARENT_ID_TOO_LONG)).toBeUndefined();
  });

  it("returns undefined for a missing field", () => {
    expect(parseTraceContext(MISSING_FLAGS_FIELD)).toBeUndefined();
  });

  it("returns undefined for a non-string / missing traceparent", () => {
    expect(parseTraceContext(undefined)).toBeUndefined();
    expect(parseTraceContext(null)).toBeUndefined();
    expect(parseTraceContext(123)).toBeUndefined();
  });

  it("drops an empty-string tracestate rather than carrying it", () => {
    expect(parseTraceContext(VALID, "")).toEqual({ traceparent: VALID });
  });

  it("drops a non-string tracestate", () => {
    expect(parseTraceContext(VALID, 42)).toEqual({ traceparent: VALID });
  });

  it("carries a tracestate at exactly the 512-character cap", () => {
    const tracestate = "a".repeat(512);
    expect(parseTraceContext(VALID, tracestate)).toEqual({ traceparent: VALID, tracestate });
  });

  it("drops a tracestate longer than 512 characters, but still carries the traceparent", () => {
    const tracestate = "a".repeat(513);
    expect(parseTraceContext(VALID, tracestate)).toEqual({ traceparent: VALID });
  });
});
