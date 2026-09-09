import semver from "semver";
import { z } from "zod";
import type { ComponentDefinition } from "./types.js";

export class ComponentDefinitionError extends Error {
  constructor(type: string, message: string) {
    super(`component "${type}": ${message}`);
    this.name = "ComponentDefinitionError";
  }
}

const TYPE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/;

/**
 * Validates and freezes a component definition.
 * Attempts the JSON Schema conversion at definition time and fail-fast rejects JSON-unrepresentable
 * props types (z.date, etc.) back to the catalog author.
 */
export function defineComponent<P extends z.ZodObject>(def: ComponentDefinition<P>): ComponentDefinition<P> {
  if (!TYPE_RE.test(def.type)) {
    throw new ComponentDefinitionError(def.type, "type must match dotted identifier form");
  }
  if (semver.valid(def.version) == null) {
    throw new ComponentDefinitionError(def.type, `version "${def.version}" is not valid semver`);
  }
  if (def.description.trim().length === 0) {
    throw new ComponentDefinitionError(def.type, "description is required (used in LLM prompt)");
  }
  try {
    z.toJSONSchema(def.propsSchema, {
      target: "draft-2020-12",
      unrepresentable: "throw",
      reused: "inline",
    });
  } catch (e) {
    throw new ComponentDefinitionError(
      def.type,
      `propsSchema is not JSON-representable: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // Default implementation to native when unspecified (stop depending on spread order and make the intent explicit).
  return Object.freeze({ ...def, implementation: def.implementation ?? { kind: "native" as const } });
}
