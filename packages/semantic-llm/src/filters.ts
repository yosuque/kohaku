import type { IntentDef } from "@kohaku-ui/intents";
import type { CanonicalIntent, FilterDescriptor, JsonObject } from "@kohaku-ui/spec-core";

/**
 * The default budget of the filter product check: the number of option combinations `vetFilters` will validate
 * against the Intent's params. It is the composer's default `l1FiltersMaxVariants` (64) -- a capability
 * enumerates one read scope per injected variant, so the composer abandons an injection past that cap anyway.
 */
export const DEFAULT_MAX_FILTER_VARIANTS = 64;

/**
 * Makes the Intent's own params schema the authority over the filters a SemanticPort offers
 * (`describeFilters`). `IntentDef.filters` enumerates every facet's options independently, but the composer
 * signs the whole cartesian product of the injected `data.bind` values into the capability, and the read path
 * (`/binding/resolve`) never validates a ref against the Intent's params: a `refine` that forbids a
 * combination (or a facet option the schema does not accept) would otherwise be reachable through a filter.
 *
 *  1. Each option is validated on its own: `params.safeParse({ ...intent.params, [param]: option })`; an option
 *     the schema rejects is dropped.
 *  2. A filter left with fewer than 2 options is dropped (nothing to choose).
 *  3. The cartesian product of the remaining filters (bounded by `maxVariants`) is validated the same way. If
 *     any combination fails, or the product exceeds the budget (not provable), NO filter is returned for the
 *     Intent -- fail-safe, never worse than not injecting.
 */
export function vetFilters(
  def: IntentDef,
  intent: CanonicalIntent,
  filters: FilterDescriptor[],
  maxVariants: number,
): FilterDescriptor[] {
  const base = intent.params as JsonObject;
  const accepts = (overrides: Record<string, string>): boolean =>
    def.params.safeParse({ ...base, ...overrides }).success;

  const vetted = filters
    .map((f) => ({ ...f, options: f.options.filter((o) => accepts({ [f.param]: o.value })) }))
    .filter((f) => f.options.length >= 2);
  if (vetted.length === 0) return vetted;

  let total = 1;
  for (const f of vetted) total *= f.options.length;
  if (total > maxVariants) return [];

  // Odometer over the options of every filter.
  const counters = vetted.map(() => 0);
  for (let n = 0; n < total; n++) {
    const overrides: Record<string, string> = {};
    vetted.forEach((f, i) => {
      overrides[f.param] = f.options[counters[i]!]!.value;
    });
    if (!accepts(overrides)) return [];
    for (let i = counters.length - 1; i >= 0; i--) {
      counters[i]!++;
      if (counters[i]! < vetted[i]!.options.length) break;
      counters[i] = 0;
    }
  }
  return vetted;
}
