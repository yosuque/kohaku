import { isPlainObject } from "./internal.js";

/**
 * Unwraps the "optional" encoding some MCP SDKs produce for a parameter that may be null: Pydantic (the Python
 * MCP SDK) writes `Optional[int]` as `{ "anyOf": [{ "type": "integer" }, { "type": "null" }] }`. Returns the
 * non-null branch, or the property itself when it is not of that exact two-branch shape.
 *
 * Used where a parameter's scalar type is read (string-argument coercion, Intent params). It is deliberately not
 * used by the `paramsSchema` projection, which treats every `anyOf` as unrepresentable.
 */
export function unwrapNullable(property: unknown): unknown {
  if (!isPlainObject(property)) return property;
  const branches = property["anyOf"];
  if (!Array.isArray(branches) || branches.length !== 2) return property;
  const isNull = (branch: unknown) => isPlainObject(branch) && branch["type"] === "null";
  const nullCount = branches.filter(isNull).length;
  if (nullCount !== 1) return property;
  return branches.find((branch) => !isNull(branch));
}
