/** True for a non-null, non-array object (a JSON object). Shared by the schema and result readers. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
