import {
  type CanonicalIntent,
  type IntentInput,
  IntentValidationError,
  type SemanticInput,
  type SemanticPort,
  type SessionContext,
} from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import { resolveIntent } from "../src/intent.js";

const SESSION: SessionContext = { surface: "web" };

function stubSemantic(
  normalize: (input: SemanticInput, session: SessionContext) => ReturnType<SemanticPort["normalize"]>,
  validateIntent?: (
    intent: IntentInput,
    session: SessionContext,
  ) => ReturnType<NonNullable<SemanticPort["validateIntent"]>>,
): Pick<SemanticPort, "normalize" | "validateIntent"> {
  return validateIntent != null ? { normalize, validateIntent } : { normalize };
}

describe("resolveIntent", () => {
  it('kind: "intent" with no validateIntent on semantic finalizes the given IntentInput directly, unchecked (backward compatible)', async () => {
    const normalize = vi.fn();
    const semantic = stubSemantic(normalize);
    const result = await resolveIntent(
      semantic,
      { kind: "intent", intent: { canonical: "sales.trend", params: { fiscalYear: 2026 } } },
      SESSION,
    );
    expect(normalize).not.toHaveBeenCalled();
    expect(result.intent.canonical).toBe("sales.trend");
    expect(result.intent.params).toEqual({ fiscalYear: 2026 });
    expect(result.intent.hash).toMatch(/^sha256:/);
    expect(result.current).toBeUndefined();
  });

  it('kind: "intent" with validateIntent on semantic calls it before finalizing, and finalizes its (possibly normalized) return value', async () => {
    const normalize = vi.fn();
    const validateIntent = vi.fn(async (intent: IntentInput) => ({
      canonical: intent.canonical,
      // Simulates a catalog filling in a schema default the caller omitted.
      params: { metric: "revenue", ...intent.params },
    }));
    const semantic = stubSemantic(normalize, validateIntent);
    const result = await resolveIntent(
      semantic,
      { kind: "intent", intent: { canonical: "sales.trend", params: { fiscalYear: 2026 } } },
      SESSION,
    );
    expect(normalize).not.toHaveBeenCalled();
    expect(validateIntent).toHaveBeenCalledWith(
      { canonical: "sales.trend", params: { fiscalYear: 2026 } },
      SESSION,
    );
    expect(result.intent.params).toEqual({ fiscalYear: 2026, metric: "revenue" });
  });

  it('kind: "intent" propagates an IntentValidationError thrown by validateIntent, without finalizing anything', async () => {
    const normalize = vi.fn();
    const validateIntent = vi.fn(async () => {
      throw new IntentValidationError('unknown intent "sales.bogus"');
    });
    const semantic = stubSemantic(normalize, validateIntent);
    await expect(
      resolveIntent(semantic, { kind: "intent", intent: { canonical: "sales.bogus", params: {} } }, SESSION),
    ).rejects.toBeInstanceOf(IntentValidationError);
  });

  it('kind: "nl" normalizes the text via semantic.normalize, then finalizes the result', async () => {
    const normalize = vi.fn(async (input: SemanticInput) => {
      expect(input).toEqual({ kind: "nl", text: "quarterly sales" });
      return { canonical: "sales.quarterly_summary", params: { quarter: 3 }, hash: "" };
    });
    const semantic = stubSemantic(normalize);
    const result = await resolveIntent(semantic, { kind: "nl", text: "quarterly sales" }, SESSION);
    expect(normalize).toHaveBeenCalledWith({ kind: "nl", text: "quarterly sales" }, SESSION);
    expect(result.intent.canonical).toBe("sales.quarterly_summary");
    expect(result.intent.params).toEqual({ quarter: 3 });
    expect(result.current).toBeUndefined();
  });

  it('kind: "nl" with locale forwards the locale to semantic.normalize (mirroring NLQuery.locale)', async () => {
    const normalize = vi.fn(async (input: SemanticInput) => {
      expect(input).toEqual({ kind: "nl", text: "quarterly sales", locale: "ja" });
      return { canonical: "sales.quarterly_summary", params: { quarter: 3 }, hash: "" };
    });
    const semantic = stubSemantic(normalize);
    const result = await resolveIntent(
      semantic,
      { kind: "nl", text: "quarterly sales", locale: "ja" },
      SESSION,
    );
    expect(normalize).toHaveBeenCalledWith({ kind: "nl", text: "quarterly sales", locale: "ja" }, SESSION);
    expect(result.intent.canonical).toBe("sales.quarterly_summary");
  });

  it('kind: "gui" normalizes the delta against `current` via semantic.normalize, finalizes the result, and echoes back `current`', async () => {
    const current: CanonicalIntent = {
      canonical: "sales.trend",
      params: { region: "us" },
      hash: "sha256:" + "0".repeat(64),
    };
    const normalize = vi.fn(async (input: SemanticInput) => {
      expect(input).toEqual({
        kind: "gui",
        action: "view.drilldown",
        params: { region: "japan" },
        current,
      });
      return { canonical: "sales.trend", params: { region: "japan" }, hash: "" };
    });
    const semantic = stubSemantic(normalize);
    const result = await resolveIntent(
      semantic,
      { kind: "gui", current, action: "view.drilldown", params: { region: "japan" } },
      SESSION,
    );
    expect(normalize).toHaveBeenCalledWith(
      { kind: "gui", action: "view.drilldown", params: { region: "japan" }, current },
      SESSION,
    );
    expect(result.intent.canonical).toBe("sales.trend");
    expect(result.intent.params).toEqual({ region: "japan" });
    // The gui branch echoes back the pre-event `current` Intent for the caller's own bookkeeping.
    expect(result.current).toBe(current);
  });

  it('kind: "gui" with no `current` (a fresh gui action against no prior Intent) normalizes without one and returns no `current`', async () => {
    const normalize = vi.fn(async (input: SemanticInput) => {
      expect(input).toEqual({ kind: "gui", action: "view.open", params: { region: "japan" } });
      return { canonical: "sales.trend", params: { region: "japan" }, hash: "" };
    });
    const semantic = stubSemantic(normalize);
    const result = await resolveIntent(
      semantic,
      { kind: "gui", action: "view.open", params: { region: "japan" } },
      SESSION,
    );
    expect(normalize).toHaveBeenCalledWith(
      { kind: "gui", action: "view.open", params: { region: "japan" } },
      SESSION,
    );
    expect(result.intent.canonical).toBe("sales.trend");
    expect(result.current).toBeUndefined();
  });
});
