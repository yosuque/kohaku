import type { z } from "zod";
import type { IntentToolDef } from "./server.js";

/**
 * A generic view of the Intent catalog. Since host-mcp-apps does not depend on sample-api (the dependency direction must
 * not flow backward), it structurally requires only the minimal fields needed to generate MCP intent tools
 * (sample-api's IntentDef is assignable to this shape).
 */
export interface IntentToolSource {
  /** The canonical Intent name (e.g., "sales.quarterly_summary"). Normalized into an MCP tool name. */
  name: string;
  /** Tool description (placed verbatim into the MCP tool's description). */
  description: string;
  /** The Zod params schema. Used for inputSchema (the SDK converts it to JSON Schema) and default filling. */
  params: z.ZodObject;
}

export interface IntentToolsOptions {
  /**
   * The tool-name prefix (namespace separation). When specified, the name becomes `<prefix>_<normalized name>`.
   * The default is none (only canonical-name normalization; assumes canonical already has a namespace such as `sales.`).
   */
  namePrefix?: string;
}

/**
 * Normalizes a canonical Intent name to the MCP tool naming constraint ([A-Za-z0-9_-]).
 * Example: "sales.quarterly_summary" → "sales_quarterly_summary"
 * Unsupported characters (dots, etc.) are folded, collapsing runs into a single "_", and trailing/leading "_" are dropped.
 */
export function toMcpToolName(canonical: string, namePrefix?: string): string {
  const base = canonical.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return namePrefix != null && namePrefix !== "" ? `${namePrefix}_${base}` : base;
}

/**
 * Machine-generates a set of MCP intent tools from an Intent catalog (an array of the generic view).
 * - inputSchema is each Intent's Zod params raw shape (the SDK converts it to JSON Schema and also fills defaults).
 * - toIntent keeps the canonical name as-is (the compose intent path recomputes the hash with finalizeIntent).
 * The generated result can be passed directly to the existing intentTools registration path (attachKohakuToMcpServer).
 *
 * Tool names are normalized to the MCP naming constraint, and post-normalization collisions or empty names are rejected
 * with an error (deterministically). Dynamic promoted Intents are turned into tools the same way if included in the catalog
 * array (registration is static at startup).
 */
export function intentToolsFromCatalog(
  defs: readonly IntentToolSource[],
  options: IntentToolsOptions = {},
): IntentToolDef[] {
  const byToolName = new Map<string, string>(); // normalized tool name → originating canonical (for collision detection)
  const tools: IntentToolDef[] = [];
  for (const def of defs) {
    const name = toMcpToolName(def.name, options.namePrefix);
    if (name === "") {
      throw new Error(`Cannot generate a valid MCP tool name from Intent "${def.name}"`);
    }
    const collided = byToolName.get(name);
    if (collided != null) {
      throw new Error(`MCP tool name "${name}" collides between Intent "${collided}" and "${def.name}"`);
    }
    byToolName.set(name, def.name);
    const canonical = def.name;
    tools.push({
      name,
      description: def.description,
      paramsShape: def.params.shape,
      toIntent: (args) => ({ canonical, params: args }),
    });
  }
  return tools;
}
