import {
  type DataShape,
  type FilterDescriptor,
  formatQueryRef,
  parseQueryRef,
  type QueryHandle,
} from "@kohaku-ui/spec-core";

/** A ref's source / path / params, or null when it does not parse (the handle then governs nothing). */
function parseHandle(uri: string): ReturnType<typeof parseQueryRef> | null {
  try {
    return parseQueryRef(uri);
  } catch {
    return null;
  }
}

/** The column names of a shape as a sorted, de-duplicated list (a set compare: column order is not a shape change). */
function columnNames(shape: DataShape): string[] {
  return [...new Set(shape.columns.map((c) => c.name))].sort();
}

function sameColumns(a: DataShape, b: DataShape): boolean {
  const x = columnNames(a);
  const y = columnNames(b);
  return x.length === y.length && x.every((name, i) => name === y[i]);
}

/**
 * Defence in depth for `ComposePolicy.l1Filters` (design.md #78): drops every descriptor whose options would
 * CHANGE THE RESULT'S COLUMN NAMES. An injected filter only swaps the value of a bound query parameter, so a
 * generated component's `x` / `y` / `columns` props keep naming the columns of the initial variant; a filter
 * that renames the measure (metric), the time column (granularity) or the dimension (groupBy) would leave the
 * chart or table pointing at columns the new variant no longer returns (a blank view). The primary guard is a
 * facet declared `filterable: false` (`@kohaku-ui/intents`); this catches a descriptor from a port or an Intent
 * that did not declare it.
 *
 * The check uses `SemanticPort.describeShape` (column metadata, never rows -- the same optional method the
 * chart-kind rule uses): for every handle a descriptor governs (its path is in `paths`, its `queryParam` is in
 * the ref) the variant ref of each option is described and compared with the handle's own shape
 * (`shapesByRef`, set equality of the column names). A descriptor is dropped when any variant differs or its
 * shape cannot be obtained (a variant that does not resolve is not safe to offer). A descriptor is kept as-is,
 * unchecked, when there is nothing to compare against: no `describeShape`, or the governed handle's own shape
 * is unknown (document: a port without `describeShape` must mark shape-changing facets `filterable: false`).
 * A descriptor with more distinct options than `maxVariants` is not described either (kept as-is): injectFilters
 * abandons the whole injection for it (`variant-limit`) whatever its shapes are, so the fan-out of one
 * `describeShape` call per option would be wasted.
 * Returns the input array when nothing was dropped.
 */
export async function dropShapeChangingFilters(
  descriptors: FilterDescriptor[],
  handles: readonly QueryHandle[],
  shapesByRef: ReadonlyMap<string, DataShape>,
  describeShape: ((handle: QueryHandle) => Promise<DataShape>) | undefined,
  maxVariants: number,
): Promise<FilterDescriptor[]> {
  if (describeShape == null || descriptors.length === 0) return descriptors;
  // One describeShape call per distinct variant ref, whatever the number of descriptors / handles asking.
  const memo = new Map<string, Promise<DataShape | null>>();
  const shapeOf = (handle: QueryHandle): Promise<DataShape | null> => {
    let pending = memo.get(handle.uri);
    if (pending == null) {
      pending = describeShape(handle).then(
        (shape) => shape,
        () => null,
      );
      memo.set(handle.uri, pending);
    }
    return pending;
  };

  const verdicts = await Promise.all(
    descriptors.map(async (descriptor): Promise<boolean> => {
      const paths = Array.isArray(descriptor.paths) ? descriptor.paths : [];
      if (new Set(descriptor.options.map((o) => o.value)).size > maxVariants) return true;
      for (const handle of handles) {
        const ref = parseHandle(handle.uri);
        if (ref == null || !paths.includes(ref.path) || !Object.hasOwn(ref.params, descriptor.queryParam)) {
          continue;
        }
        const base = shapesByRef.get(handle.uri);
        if (base == null) continue; // nothing to compare against
        const current = ref.params[descriptor.queryParam];
        for (const option of descriptor.options) {
          if (option.value === current) continue;
          const variantUri = formatQueryRef({
            source: ref.source,
            path: ref.path,
            params: { ...ref.params, [descriptor.queryParam]: option.value },
          });
          const shape = await shapeOf({ ...handle, uri: variantUri });
          if (shape == null || !sameColumns(base, shape)) return false;
        }
      }
      return true;
    }),
  );
  return verdicts.every(Boolean) ? descriptors : descriptors.filter((_, i) => verdicts[i]);
}
