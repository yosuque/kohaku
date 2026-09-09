import { describe, expect, it, vi } from "vitest";
import { applyActionEffects } from "../src/action-effects.js";

describe("applyActionEffects", () => {
  it("with no actionEffects declared, returns only { result }", async () => {
    const onEffectsError = vi.fn();
    const response = await applyActionEffects(
      undefined,
      "sales.updateTarget",
      {},
      { ok: true },
      onEffectsError,
    );
    expect(response).toEqual({ result: { ok: true } });
    expect(onEffectsError).not.toHaveBeenCalled();
  });

  it("a null result is normalized to null (not undefined) and no invalidates/refVersions keys are added when absent", async () => {
    const onEffectsError = vi.fn();
    const response = await applyActionEffects(undefined, "sales.updateTarget", {}, undefined, onEffectsError);
    expect(response).toEqual({ result: null });
    expect("invalidates" in response).toBe(false);
    expect("refVersions" in response).toBe(false);
  });

  it("normal case: invalidates / refVersions from actionEffects pass through", async () => {
    const actionEffects = vi.fn(async (_action: string, _payload: object, _result: unknown) => ({
      invalidates: ["query://sales/summary?fy=2026"],
      refVersions: { "query://sales/summary?fy=2026": "v2" },
    }));
    const onEffectsError = vi.fn();
    const response = await applyActionEffects(
      actionEffects,
      "sales.updateTarget",
      { fiscalYear: 2026 },
      { updated: true },
      onEffectsError,
    );
    expect(actionEffects).toHaveBeenCalledWith("sales.updateTarget", { fiscalYear: 2026 }, { updated: true });
    expect(response).toEqual({
      result: { updated: true },
      invalidates: ["query://sales/summary?fy=2026"],
      refVersions: { "query://sales/summary?fy=2026": "v2" },
    });
    expect(onEffectsError).not.toHaveBeenCalled();
  });

  it("fail-open: when actionEffects throws, onEffectsError is called and the response still succeeds with { result } only", async () => {
    const boom = new Error("effects boom");
    const actionEffects = vi.fn(async () => {
      throw boom;
    });
    const onEffectsError = vi.fn();
    const response = await applyActionEffects(
      actionEffects,
      "sales.updateTarget",
      {},
      { updated: true },
      onEffectsError,
    );
    expect(onEffectsError).toHaveBeenCalledWith(boom);
    expect(response).toEqual({ result: { updated: true } });
  });
});
