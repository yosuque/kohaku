/**
 * Tier accents (L0 fixed / L1 declarative / L2 free): kept as literals because they are semantic (which
 * generation tier produced a part), not themed — a product's ThemeTokens has no opinion on tier identity, so
 * these do not follow `--kohaku-color-*` the way `theme.ts`'s `V` palette does. Domain vocabulary of the
 * console (like `describeDeniedOperation` in `rbac.ts`), so it lives at the package root, not on the generic
 * `/ui` primitives subpath.
 */
export const TIER_COLOR: Record<string, string> = { L0: "#1e40af", L1: "#166534", L2: "#c2410c" };

/** What a lineage event's "tier" column shows: the label, its color, and whether it is an action gate tier. */
export interface LineageTierCell {
  text: string;
  color: string;
  /** True for an `action.*` event's gate tier (`auto` / `confirm` / `approve`), false for an L0/L1/L2 composition tier. */
  gate: boolean;
}

/** The muted accent an action gate tier is drawn with, so it never reads as an L0/L1/L2 composition tier. */
const GATE_COLOR = "#6b21a8";

/**
 * The value of a lineage event's "tier" cell, or `null` when the event has none.
 *
 * Two unrelated things are both called "tier" on the wire: `view.*` / `component.*` events carry the
 * composition tier (L0/L1/L2, `TIER_COLOR`), while `action.*` events carry a governed action's gate tier
 * (`auto` / `confirm` / `approve`, design.md #62/#63). Showing `payload.tier` for every event would mix
 * `L1` and `approve` in one column, so the composition tier is read only from `view.*` / `component.*`
 * events and an action's gate tier is rendered as `gate:<tier>` in its own color.
 */
export function lineageTierCell(event: {
  type: string;
  payload: Record<string, unknown>;
}): LineageTierCell | null {
  const tier = event.payload["tier"];
  if (typeof tier !== "string") return null;
  if (event.type.startsWith("view.") || event.type.startsWith("component.")) {
    return { text: tier, color: TIER_COLOR[tier] ?? "", gate: false };
  }
  if (event.type.startsWith("action.")) {
    return { text: `gate:${tier}`, color: GATE_COLOR, gate: true };
  }
  return null;
}
