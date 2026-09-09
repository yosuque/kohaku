import {
  type ComponentNode,
  normalizeJsonValue,
  orderComponents,
  ROOT_COMPONENT_ID,
  SANDBOX_HTML_TYPE,
} from "@kohaku-ui/spec-core";
import type { PostRule } from "./types.js";

/** type → deterministic ID prefix */
const ID_PREFIX: Record<string, string> = {
  "layout.stack": "stack",
  "layout.grid": "grid",
  "layout.tabs": "tabs",
  "layout.tab": "tab",
  "text.heading": "title",
  presentChart: "chart",
  presentSpreadsheet: "table",
  presentMarkdown: "md",
  presentForm: "form",
  presentMetric: "metric",
  presentList: "list",
  "action.button": "btn",
  "ui.loading": "loading",
  [SANDBOX_HTML_TYPE]: "sandbox",
};

function idPrefix(type: string): string {
  return ID_PREFIX[type] ?? type.replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase();
}

/**
 * ID determinization: root stays as-is, others become "type prefix + sequence number" in DFS order.
 * children / events references are also rewritten consistently via the rename table (application order is always first).
 */
export const normalizeIds: PostRule = (spec) => {
  const ordered = orderComponents(spec.components);
  const rename = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const node of ordered) {
    if (node.id === ROOT_COMPONENT_ID) {
      rename.set(node.id, ROOT_COMPONENT_ID);
      continue;
    }
    const prefix = idPrefix(node.type);
    const n = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, n);
    rename.set(node.id, `${prefix}${n}`);
  }

  const components = ordered.map((node) => ({
    ...node,
    id: rename.get(node.id)!,
    ...(node.children != null ? { children: node.children.map((c) => rename.get(c) ?? c) } : {}),
  }));

  const events = spec.events.map((e) => {
    const dot = e.on.indexOf(".");
    if (dot < 0) return e; // do not touch values not in "componentId.eventName" form (prevents mis-extracting a substring)
    const target = e.on.slice(0, dot);
    const renamed = rename.get(target);
    return renamed != null ? { ...e, on: `${renamed}${e.on.slice(dot)}` } : e;
  });

  return { ...spec, components, events };
};

/**
 * Chart-kind rule: time-series x → line; a composition ratio (pie) is allowed only when the category count is 6 or fewer.
 * Overrides the LLM's choice with deterministic rules (skips when there is no DataShape).
 */
export const chartKind: PostRule = (spec, ctx) => {
  const components = spec.components.map((node): ComponentNode => {
    if (node.type !== "presentChart" || node.data == null) return node;
    const shape = ctx.shapesByRef.get(node.data.$ref);
    if (shape == null) return node;

    const props = { ...node.props };
    const xCol = shape.columns.find((c) => c.name === props["x"]);
    if (xCol != null && (xCol.role === "time" || xCol.type === "date")) {
      props["kind"] = "line";
    } else if (props["kind"] === "pie" && (shape.rowCountHint ?? Infinity) > 6) {
      // An unknown row count (no rowCountHint) is treated as Infinity, erring on the safe side and changing pie to bar
      // (avoids a pie with too many categories).
      props["kind"] = "bar";
    }
    return { ...node, props };
  });
  return { ...spec, components };
};

/**
 * Deterministic order: put components into canonical order via DFS from root.
 * Fills presentSpreadsheet with a default sort (descending on the first measure column).
 */
export const sortOrder: PostRule = (spec, ctx) => {
  const components = orderComponents(spec.components).map((node): ComponentNode => {
    if (node.type !== "presentSpreadsheet" || node.data == null) return node;
    if (node.props["sortBy"] != null) return node;
    const shape = ctx.shapesByRef.get(node.data.$ref);
    const measure = shape?.columns.find((c) => c.role === "measure");
    if (measure == null) return node;
    return { ...node, props: { ...node.props, sortBy: { field: measure.name, dir: "desc" } } };
  });
  return { ...spec, components };
};

/**
 * props normalization: fill catalog defaults (using validate's normalized) +
 * key-order normalization. Guarantees byte-level determinism.
 */
export const canonicalProps: PostRule = (spec, ctx) => {
  const { normalized } = ctx.catalog.validate(spec.components, spec.events);
  const components = normalized.map((node) => normalizeJsonValue(node) as ComponentNode);
  return {
    ...spec,
    components,
    events: spec.events.map((e) => normalizeJsonValue(e)),
  };
};

export const STANDARD_RULES: PostRule[] = [normalizeIds, chartKind, sortOrder, canonicalProps];
