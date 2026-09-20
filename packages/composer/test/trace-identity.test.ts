import { describe, expect, it } from "vitest";
import { traceIdentity } from "../src/trace-identity.js";

describe("traceIdentity", () => {
  it("returns both keys when both correlationId and traceContext are present", () => {
    const result = traceIdentity({
      correlationId: "req-1",
      traceContext: { traceparent: "00-trace-01" },
    });
    expect(result).toEqual({
      correlationId: "req-1",
      traceContext: { traceparent: "00-trace-01" },
    });
    expect(Object.keys(result)).toHaveLength(2);
  });

  it("returns only correlationId when traceContext is absent", () => {
    const result = traceIdentity({ correlationId: "req-1" });
    expect(result).toEqual({ correlationId: "req-1" });
    expect(Object.keys(result)).toEqual(["correlationId"]);
  });

  it("returns only traceContext when correlationId is absent", () => {
    const result = traceIdentity({ traceContext: { traceparent: "00-trace-01" } });
    expect(result).toEqual({ traceContext: { traceparent: "00-trace-01" } });
    expect(Object.keys(result)).toEqual(["traceContext"]);
  });

  it("returns an empty object (no undefined-valued keys) when neither is present", () => {
    const result = traceIdentity({});
    expect(result).toEqual({});
    expect(Object.keys(result)).toHaveLength(0);
  });
});
