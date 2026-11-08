import { parseQueryRef } from "@kohaku-ui/data-binding";
import type { IntentDef } from "@kohaku-ui/intents";
import type { CanonicalIntent, FilterDescriptor, JsonObject, QueryHandle } from "@kohaku-ui/spec-core";
import type { IntentCatalogLike } from "./catalog.js";

/**
 * The default budget of the filter product check: the number of option combinations `vetFilters` will validate
 * against the Intent's params. It is the composer's default `l1FiltersMaxVariants` (64) -- a capability
 * enumerates one read scope per injected variant, so the composer abandons an injection past that cap anyway.
 */
export const DEFAULT_MAX_FILTER_VARIANTS = 64;

/**
 * The validator the Intent is actually enforced by: returns the normalized params (defaults filled in), or null
 * when they are rejected.
 */
export type ParamsCheck = (params: JsonObject) => JsonObject | null;

/**
 * The checker for `def` through `catalog`: its `validateParams` (strict, the one NL / GUI normalization and
 * `validateIntent` enforce), else its `normalizeParams`, else the bare schema. A product catalog may add
 * constraints on top of the schema, and those are what `/compose` actually enforces.
 */
export function paramsCheckFor(catalog: IntentCatalogLike, def: IntentDef): ParamsCheck {
  if (typeof catalog.validateParams === "function") {
    return (params) => {
      const result = catalog.validateParams!(def.name, params);
      return result.ok ? result.params : null;
    };
  }
  if (typeof catalog.normalizeParams === "function") {
    return (params) => catalog.normalizeParams(def.name, params);
  }
  return (params) => {
    const parsed = def.params.safeParse(params);
    return parsed.success ? (parsed.data as JsonObject) : null;
  };
}

/**
 * The value every governed ref of the Intent currently carries for the filter's query param, or undefined when
 * the composer would not inject the filter (no ref on one of its `paths` carries the param, or the carriers
 * disagree) -- injectFilters' own rule, read off the refs the Intent resolves to.
 */
function currentValue(filter: FilterDescriptor, handles: readonly QueryHandle[]): string | undefined {
  const carried = new Set<string>();
  for (const handle of handles) {
    let ref: ReturnType<typeof parseQueryRef>;
    try {
      ref = parseQueryRef(handle.uri);
    } catch {
      continue;
    }
    if (filter.paths.includes(ref.path) && Object.hasOwn(ref.params, filter.queryParam)) {
      carried.add(ref.params[filter.queryParam]!);
    }
  }
  return carried.size === 1 ? [...carried][0] : undefined;
}

/**
 * Makes the Intent's own params validation the authority over the filters a SemanticPort offers
 * (`describeFilters`). `IntentDef.filters` enumerates every facet's options independently, but the composer signs
 * the whole cartesian product of the injected `data.bind` values into the capability, and the read path
 * (`/binding/resolve`) never validates a ref against the Intent's params: a `refine` that forbids a
 * combination (or a facet option the schema does not accept) would otherwise be reachable through a filter.
 *
 *  0. The Intent's own params are validated first (`check`); rejected params offer no filters.
 *  1. A filter the composer would NOT inject is dropped: no ref of the Intent carries its query param on its
 *     `paths`, the carriers disagree, or the carried value is not among its options (injectFilters' skip rule).
 *     Such a param stays at its un-vetted value in the signed product, so the product below must not range
 *     over it; the vetted product is exactly the signed one.
 *  2. Each remaining option is validated on its own: `check({ ...params, [param]: option })`; a rejected option
 *     is dropped.
 *  3. A filter left with fewer than 2 options is dropped (nothing to choose).
 *  4. The cartesian product of what remains (bounded by `maxVariants`) is validated the same way. If any
 *     combination fails, or the product exceeds the budget (not provable), NO filter is returned for the
 *     Intent -- fail-safe, never worse than not injecting.
 *
 * The budget counts the product over ALL remaining filters, a superset of any one component's product that
 * the composer counts (its `totalVariants` is a per-component product summed over components): it is
 * deliberately conservative.
 */
export function vetFilters(
  def: IntentDef,
  intent: CanonicalIntent,
  filters: FilterDescriptor[],
  maxVariants: number,
  check: ParamsCheck,
): FilterDescriptor[] {
  const base = check(intent.params as JsonObject);
  if (base == null) return [];
  let handles: QueryHandle[];
  try {
    handles = def.toQueries(intent.params as JsonObject);
  } catch {
    return [];
  }
  const accepts = (overrides: Record<string, string>): boolean => check({ ...base, ...overrides }) != null;

  const vetted = filters
    .filter((f) => {
      const value = currentValue(f, handles);
      return value != null && f.options.some((o) => o.value === value);
    })
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
