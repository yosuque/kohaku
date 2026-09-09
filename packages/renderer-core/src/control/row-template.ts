import type { ComponentNode, JsonObject, JsonValue } from "@kohaku-ui/spec-core";

/**
 * Props injection for the row-template mechanism (presentList). A pure function
 * paired with resolvePayloadTemplate. Recursively walks node.props and returns a
 * **new node** with string values "$row.<column>" replaced by that row's value.
 * Only props are targeted; visibleWhen ($state references) and data.$ref are left
 * untouched.
 *
 * Because only one place on the tree-construction side applies this, individual
 * part implementations know nothing about the row-template mechanism.
 */
export function resolveRowProps(node: ComponentNode, row: JsonObject): ComponentNode {
  return { ...node, props: substituteRow(node.props, row) as JsonObject };
}

/** Recursively walks a JSON value and replaces "$row.<key>" strings with the row's value (descending into objects and arrays too). */
export function substituteRow(value: JsonValue, row: JsonObject): JsonValue {
  if (typeof value === "string") {
    return value.startsWith("$row.") ? (row[value.slice("$row.".length)] ?? null) : value;
  }
  if (Array.isArray(value)) return value.map((v) => substituteRow(v, row));
  if (value != null && typeof value === "object") {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteRow(v, row);
    return out;
  }
  return value;
}
