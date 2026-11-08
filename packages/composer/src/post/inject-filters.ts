import {
  ComponentIdSchema,
  type ComponentNode,
  type EventBinding,
  type FilterDescriptor,
  MAX_BIND_VARIANTS,
  parseQueryRef,
  ROOT_COMPONENT_ID,
  StateKeySchema,
  type UISpec,
  validateSpecStructure,
} from "@kohaku-ui/spec-core";

/** The root types that can host injected controls as children (both declare `children: "optional"`). */
const HOST_ROOT_TYPES: ReadonlySet<string> = new Set(["layout.stack", "layout.grid"]);

/**
 * The default cap on the bind variants one injection may create (`ComposePolicy.l1FiltersMaxVariants`). A
 * capability enumerates one read scope per variant: 256 scopes are about 35 KB, past Node's 16 KiB header limit
 * (so `/binding/resolve` would answer 431), while 64 stay near 9 KB. Always further bounded by spec-core's
 * MAX_BIND_VARIANTS.
 */
export const DEFAULT_L1_FILTERS_MAX_VARIANTS = 64;

export interface InjectFiltersOptions {
  /** Cap on the total bind variants (default {@link DEFAULT_L1_FILTERS_MAX_VARIANTS}; never above MAX_BIND_VARIANTS). */
  maxVariants?: number;
}

export interface InjectFiltersResult {
  spec: UISpec;
  /** The `FilterDescriptor.param` of every filter that was injected, in descriptor order. */
  injected: string[];
  /**
   * Set when filters were applicable but the whole injection was abandoned (the input Spec is returned
   * unchanged): `variant-limit` when the bind variants would exceed `maxVariants` (itself capped by spec-core's
   * MAX_BIND_VARIANTS), `invalid` when the root cannot host controls or the result failed structural validation.
   */
  skipped?: "variant-limit" | "invalid";
}

interface Plan {
  descriptor: FilterDescriptor;
  /** The current value: the shared `queryParam` value of every data component this filter governs. */
  value: string;
  /** The descriptor's options, de-duplicated by value (first wins): the control's options and the bind `values`. */
  options: { value: string; label: string }[];
}

/** A `$ref`'s path and query params, or null when it does not parse (the component is then simply not a target). */
function parseRef(ref: string): { path: string; params: Record<string, string> } | null {
  try {
    const parsed = parseQueryRef(ref);
    return { path: parsed.path, params: parsed.params };
  } catch {
    return null;
  }
}

/**
 * Deterministically adds Intent-declared filters to an L1 Spec (`ComposePolicy.l1Filters`). The model never
 * sees or decides this: for each `FilterDescriptor` whose `queryParam` appears in the `$ref` of a data component
 * reading one of the descriptor's `paths` it adds
 *   - a `control.select` (id `filter-<param>`, options from the descriptor, value = the ref's current value),
 *     placed first among the root's children;
 *   - `state[<param>]` = the current value (taken from the ref, so spec-core's initial-ref = initial-state
 *     check holds), and a `filter-<param>.change` -> `state.set` event;
 *   - `data.bind[<queryParam>] = { $state: <param>, values }` on every data component the filter governs (path in
 *     `paths` and the query parameter present); a component on another path is never touched.
 *
 * A descriptor is skipped (others still apply) when: no data component carries its `queryParam`; the carriers
 * disagree on its current value or it is not among `options` (e.g. a cleared "all" value -- a selected value
 * cannot be cleared back to "all" either: `bind.values` has no empty value, same as the L0 cross-filter); its
 * id / state key / event would collide with the Spec's own or violate the id grammar; or an earlier descriptor
 * already governs the same `queryParam` on an overlapping path. The whole injection is abandoned (input
 * returned unchanged) when the total bind variants would exceed `maxVariants`, the root cannot host controls,
 * or the result fails `validateSpecStructure` (fail-safe: never worse than not injecting).
 *
 * Pure, idempotent-by-collision (a second pass finds the ids taken and injects nothing), input never mutated.
 * Runs after ID normalization, so the injected ids are not renamed by it.
 */
export function injectFilters(
  spec: UISpec,
  rawDescriptors: readonly FilterDescriptor[],
  options: InjectFiltersOptions = {},
): InjectFiltersResult {
  // A descriptor from an untyped caller may lack `paths`: it then governs nothing (never a throw in post-processing).
  const descriptors = rawDescriptors.map((d) => (Array.isArray(d.paths) ? d : { ...d, paths: [] }));
  const maxVariants = Math.min(options.maxVariants ?? DEFAULT_L1_FILTERS_MAX_VARIANTS, MAX_BIND_VARIANTS);
  const unchanged = (skipped?: InjectFiltersResult["skipped"]): InjectFiltersResult => ({
    spec,
    injected: [],
    ...(skipped != null ? { skipped } : {}),
  });
  if (descriptors.length === 0) return unchanged();

  const taken = new Set(spec.components.map((c) => c.id));
  const stateKeys = new Set(Object.keys(spec.state ?? {}));
  const eventTargets = new Set(spec.events.map((e) => e.on));

  const plans: Plan[] = [];
  for (const descriptor of descriptors) {
    const { param, queryParam } = descriptor;
    const id = `filter-${param}`;
    if (!ComponentIdSchema.safeParse(id).success || !StateKeySchema.safeParse(param).success) continue;
    // `_`-prefixed query params are the reserved (authorization-exempt) namespace; spec-core rejects binding them.
    if (queryParam === "" || queryParam.startsWith("_")) continue;
    if (taken.has(id) || stateKeys.has(param) || eventTargets.has(`${id}.change`)) continue;
    if (plans.some((p) => p.descriptor.param === param)) continue;
    // One query parameter, one filter per path: a later descriptor on an overlapping path would otherwise
    // overwrite the earlier bind.
    if (
      plans.some(
        (p) =>
          p.descriptor.queryParam === queryParam &&
          p.descriptor.paths.some((x) => descriptor.paths.includes(x)),
      )
    ) {
      continue;
    }

    const carried = new Set<string>();
    let blocked = false;
    for (const c of spec.components) {
      if (c.data == null) continue;
      const ref = parseRef(c.data.$ref);
      if (ref == null || !descriptor.paths.includes(ref.path) || !Object.hasOwn(ref.params, queryParam))
        continue;
      // A component already bound on this query param is left to its own declaration: skip the filter.
      if (c.data.bind != null && Object.hasOwn(c.data.bind, queryParam)) blocked = true;
      carried.add(ref.params[queryParam]!);
    }
    if (blocked || carried.size !== 1) continue;
    const value = [...carried][0]!;
    const options: { value: string; label: string }[] = [];
    for (const o of descriptor.options) if (!options.some((x) => x.value === o.value)) options.push(o);
    if (!options.some((o) => o.value === value)) continue;
    plans.push({ descriptor, value, options });
  }
  if (plans.length === 0) return unchanged();

  const root = spec.components.find((c) => c.id === ROOT_COMPONENT_ID);
  if (root == null || !HOST_ROOT_TYPES.has(root.type) || root.children == null) return unchanged("invalid");

  // Rebuild the data components with the new binds, counting variants like spec-core's BIND_VARIANT_LIMIT
  // (per component: the product of each bound param's distinct values; summed over the Spec).
  let totalVariants = 0;
  const rebuilt = spec.components.map((c): ComponentNode => {
    if (c.data == null) return c;
    const ref = parseRef(c.data.$ref);
    const added =
      ref == null
        ? []
        : plans
            .filter(
              (p) =>
                p.descriptor.paths.includes(ref.path) && Object.hasOwn(ref.params, p.descriptor.queryParam),
            )
            .map(
              (p) =>
                [
                  p.descriptor.queryParam,
                  { $state: p.descriptor.param, values: p.options.map((o) => o.value) },
                ] as const,
            );
    const bind = { ...(c.data.bind ?? {}), ...Object.fromEntries(added) };
    totalVariants += Object.values(bind).reduce((n, b) => n * new Set(b.values).size, 1);
    return added.length === 0 ? c : { ...c, data: { ...c.data, bind } };
  });
  if (totalVariants > maxVariants) return unchanged("variant-limit");

  const controls: ComponentNode[] = plans.map(({ descriptor, value, options }) => ({
    id: `filter-${descriptor.param}`,
    type: "control.select",
    props: {
      label: descriptor.label,
      value,
      options: options.map((o) => ({ value: o.value, label: o.label })),
    },
  }));
  const components = [...rebuilt];
  const rootIndex = components.findIndex((c) => c.id === ROOT_COMPONENT_ID);
  components[rootIndex] = { ...root, children: [...controls.map((c) => c.id), ...root.children] };
  // DFS-consistent position: root first, then the controls (first among its children), then the rest.
  const ordered = [...components.slice(0, rootIndex + 1), ...controls, ...components.slice(rootIndex + 1)];

  const events: EventBinding[] = [
    ...spec.events,
    ...plans.map(({ descriptor }) => ({
      on: `filter-${descriptor.param}.change`,
      emit: "state.set" as const,
      payload: { key: descriptor.param, value: "$value" },
    })),
  ];
  const state = {
    ...(spec.state ?? {}),
    ...Object.fromEntries(plans.map((p) => [p.descriptor.param, p.value])),
  };

  const candidate: UISpec = { ...spec, components: ordered, events, state };
  if (validateSpecStructure(candidate).some((i) => i.severity === "error")) return unchanged("invalid");
  return { spec: candidate, injected: plans.map((p) => p.descriptor.param) };
}
