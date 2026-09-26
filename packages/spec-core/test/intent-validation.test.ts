import { describe, expect, it } from "vitest";
import { IntentValidationError } from "../src/errors.js";
import type { IntentInput } from "../src/intent.js";
import type { SemanticPort, SessionContext } from "../src/ports.js";

describe("IntentValidationError", () => {
  it("carries the INTENT_INVALID code and a client-safe message", () => {
    const error = new IntentValidationError('unknown intent "sales.bogus"');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("IntentValidationError");
    expect(error.code).toBe("INTENT_INVALID");
    expect(error.message).toBe('unknown intent "sales.bogus"');
    expect(error.issues).toEqual([]);
  });

  it("carries per-param issues when given", () => {
    const error = new IntentValidationError("invalid params for sales.trend", [
      { path: "metric", message: 'param "metric": expected one of revenue, units' },
      { path: "region", message: 'unknown param "region"' },
    ]);
    expect(error.issues).toEqual([
      { path: "metric", message: 'param "metric": expected one of revenue, units' },
      { path: "region", message: 'unknown param "region"' },
    ]);
  });

  it("has a string `code`, so host-core's isTypedHostError convention recognizes it as a typed host error", () => {
    const error = new IntentValidationError("boom");
    expect(typeof (error as { code?: unknown }).code).toBe("string");
  });
});

describe("SemanticPort.validateIntent", () => {
  const SESSION: SessionContext = { surface: "web" };

  it("is optional: a SemanticPort omitting it still type-checks and has no such method", async () => {
    const port: Pick<SemanticPort, "normalize" | "resolveQuery" | "dataVersion"> = {
      normalize: async (input) =>
        input.kind === "nl" ? { canonical: "x.y", params: {} } : { canonical: "x.y", params: input.params },
      resolveQuery: async () => ({ uri: "query://x/y" }),
      dataVersion: async () => "v1",
    };
    expect((port as Partial<SemanticPort>).validateIntent).toBeUndefined();
  });

  it("when implemented, validates and returns a (possibly normalized) IntentInput", async () => {
    const validateIntent = async (intent: IntentInput, ctx: SessionContext): Promise<IntentInput> => {
      expect(ctx).toBe(SESSION);
      if (intent.canonical !== "sales.trend") {
        throw new IntentValidationError(`unknown intent "${intent.canonical}"`);
      }
      // Fills in the schema default the caller omitted (mirrors a real IntentCatalogLike.validateParams).
      return { canonical: intent.canonical, params: { metric: "revenue", ...intent.params } };
    };
    const port: Pick<SemanticPort, "normalize" | "validateIntent"> = {
      normalize: async () => ({ canonical: "sales.trend", params: {} }),
      validateIntent,
    };
    const result = await port.validateIntent!({ canonical: "sales.trend", params: {} }, SESSION);
    expect(result).toEqual({ canonical: "sales.trend", params: { metric: "revenue" } });
    await expect(
      port.validateIntent!({ canonical: "sales.bogus", params: {} }, SESSION),
    ).rejects.toBeInstanceOf(IntentValidationError);
  });
});
