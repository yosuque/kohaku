import { readFileSync } from "node:fs";
import semver from "semver";

export interface ComponentValidationIssue {
  field: string;
  message: string;
}

/** component validate: validate a ComponentDefinition (JSON-serialized form) */
export function validateComponentFile(path: string): ComponentValidationIssue[] {
  const issues: ComponentValidationIssue[] = [];
  let def: Record<string, unknown>;
  try {
    def = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    // As on the index.ts side, stringify non-Error values with String(e) (unified error formatting).
    return [
      { field: "(file)", message: `Cannot read as JSON: ${e instanceof Error ? e.message : String(e)}` },
    ];
  }

  if (
    typeof def["type"] !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/.test(def["type"])
  ) {
    issues.push({ field: "type", message: "A dot-separated identifier is required" });
  }
  if (typeof def["version"] !== "string" || semver.valid(def["version"]) == null) {
    issues.push({ field: "version", message: "A valid semver is required" });
  }
  if (typeof def["description"] !== "string" || def["description"].trim() === "") {
    issues.push({
      field: "description",
      message: "Selection guidance for the LLM (description) is required",
    });
  }
  const props = def["propsSchema"];
  if (props == null || typeof props !== "object") {
    issues.push({ field: "propsSchema", message: "A JSON Schema object is required" });
  } else if ((props as { type?: string }).type !== "object") {
    issues.push({ field: "propsSchema", message: 'propsSchema.type must be "object"' });
  }
  const caps = def["capabilities"] as { data?: string } | undefined;
  if (caps == null || !["none", "optional", "required"].includes(caps.data ?? "")) {
    issues.push({ field: "capabilities.data", message: "one of none | optional | required is required" });
  }
  return issues;
}
