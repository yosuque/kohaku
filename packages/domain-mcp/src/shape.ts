import type { DataShape } from "@kohaku-ui/spec-core";

type ShapeColumn = DataShape["columns"][number];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The item schema of the list an `outputSchema` describes (the schema twin of tabular.ts's `findRowList`). */
function rowSchemaOf(outputSchema: Record<string, unknown>): Record<string, unknown> | null {
  const itemsOf = (schema: unknown): Record<string, unknown> | null => {
    if (!isPlainObject(schema) || schema["type"] !== "array") return null;
    return isPlainObject(schema["items"]) ? schema["items"] : null;
  };
  if (outputSchema["type"] === "array") return itemsOf(outputSchema);
  const properties = outputSchema["properties"];
  if (!isPlainObject(properties)) return null;
  const rows = itemsOf(properties["rows"]);
  if (rows != null) return rows;
  const keys = Object.keys(properties);
  return keys.length === 1 ? itemsOf(properties[keys[0] as string]) : null;
}

function columnOf(name: string, property: unknown): ShapeColumn | null {
  if (!isPlainObject(property)) return null;
  switch (property["type"]) {
    case "string": {
      const format = property["format"];
      if (format === "date" || format === "date-time") return { name, type: "date", role: "time" };
      return { name, type: "string", role: "dimension" };
    }
    case "number":
    case "integer":
      return { name, type: "number", role: "measure" };
    case "boolean":
      return { name, type: "boolean" };
    default:
      return null;
  }
}

/**
 * Builds a `DataShape` (column names, types and roles, no row data) from a tool's `outputSchema`: `string` is a
 * dimension, `number` / `integer` a measure, and a `string` with format `date` / `date-time` a time column.
 * Properties of any other type (nested objects, arrays) are left out. Returns null when there is no
 * `outputSchema` or it does not describe a list of objects.
 */
export function shapeFromOutputSchema(outputSchema: unknown): DataShape | null {
  if (!isPlainObject(outputSchema)) return null;
  const row = rowSchemaOf(outputSchema);
  if (row == null || !isPlainObject(row["properties"])) return null;
  const columns: ShapeColumn[] = [];
  for (const [name, property] of Object.entries(row["properties"])) {
    const column = columnOf(name, property);
    if (column != null) columns.push(column);
  }
  return columns.length === 0 ? null : { columns };
}
