import type { GuiAction, JsonObject } from "@kohaku-ui/spec-core";
import type { IntentCatalogLike } from "./catalog.js";

/**
 * Deterministic normalization of GUI operations (never goes through the LLM).
 * 1. `view.select` / `facet.change`: the target Intent comes from params.intent (or the current Intent); facets
 *    are merged over the current params only when the Intent is unchanged.
 * 2. A component event ("table1.rowClick", …) with a current Intent: delegated to the definition's drilldown, or,
 *    without one, the payload is merged into the current params.
 */
export function normalizeGuiAction(
  input: GuiAction,
  catalog: IntentCatalogLike,
): { canonical: string; params: JsonObject } {
  if (input.action === "view.select" || input.action === "facet.change") {
    const requested = (input.params["intent"] as string | undefined) ?? input.current?.canonical;
    if (requested == null) throw new Error("view.select requires params.intent");
    const def = catalog.get(requested);
    if (def == null) throw new Error(`unknown intent: ${requested}`);
    const { intent: _drop, ...facets } = input.params;
    const base = input.current?.canonical === requested ? input.current.params : {};
    const params = catalog.normalizeParams(requested, { ...base, ...facets } as JsonObject);
    if (params == null) throw new Error(`invalid params for ${requested}`);
    return { canonical: requested, params };
  }

  if (input.action.includes(".") && input.current != null) {
    const def = catalog.get(input.current.canonical);
    if (def?.drilldown != null) {
      const next = def.drilldown(input.current.params, input.params);
      const canonical = next.canonical ?? input.current.canonical;
      const params = catalog.normalizeParams(canonical, next.params);
      if (params == null) throw new Error(`drilldown produced invalid params for ${canonical}`);
      return { canonical, params };
    }
    const params = catalog.normalizeParams(input.current.canonical, {
      ...input.current.params,
      ...input.params,
    } as JsonObject);
    if (params == null) throw new Error("event payload produced invalid params");
    return { canonical: input.current.canonical, params };
  }

  throw new Error(`unsupported gui action: ${input.action}`);
}
