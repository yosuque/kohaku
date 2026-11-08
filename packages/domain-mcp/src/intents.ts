import { defineIntent, type IntentDef } from "@kohaku-ui/intents";
import { z } from "zod";
import { isPlainObject } from "./internal.js";
import { unwrapNullable } from "./nullable.js";
import type { McpDomainPort } from "./port.js";
import type { McpToolInfo } from "./types.js";

export interface McpIntentsOptions {
  /**
   * The `query://` source the Intents resolve against (the `querySource` of the host). It also prefixes every
   * canonical name, so it must be lowercase letters, digits and underscores, starting with a letter.
   */
  source: string;
  /** Called for a read-only tool that gets no Intent, with the reason. */
  onSkip?: (report: { tool: string; reason: string }) => void;
}

const SOURCE_PATTERN = /^[a-z][a-z0-9_]*$/;

/** `Get-Orders` -> `get_orders`, `9lives` -> `t_9lives`: a name `CanonicalNameSchema` accepts as one segment. */
function canonicalSegment(toolName: string): string {
  const lowered = toolName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return /^[a-z]/.test(lowered) ? lowered : `t_${lowered}`;
}

/** The Zod field for one scalar `inputSchema` property, or null when the type has no Intent-param form. */
function fieldFor(rawProperty: unknown): z.ZodType | null {
  const property = unwrapNullable(rawProperty);
  if (!isPlainObject(property)) return null;
  switch (property["type"]) {
    case "string": {
      const values = property["enum"];
      if (Array.isArray(values) && values.length > 0 && values.every((v) => typeof v === "string")) {
        return z.enum(values as [string, ...string[]]);
      }
      return z.string();
    }
    case "number":
    case "integer": {
      let field = z.coerce.number();
      if (property["type"] === "integer") field = field.int();
      if (typeof property["minimum"] === "number") field = field.min(property["minimum"]);
      if (typeof property["maximum"] === "number") field = field.max(property["maximum"]);
      return field;
    }
    default:
      return null;
  }
}

function paramsFor(tool: McpToolInfo): { shape: Record<string, z.ZodType> } | { skip: string } {
  const properties = isPlainObject(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
  const required = new Set(tool.inputSchema.required ?? []);
  const shape: Record<string, z.ZodType> = {};
  for (const [name, property] of Object.entries(properties)) {
    const field = fieldFor(property);
    if (field == null) {
      // An optional parameter we cannot express is simply not settable through an Intent; a required one would
      // make every resolved ref invalid.
      if (required.has(name))
        return { skip: `required parameter "${name}" has a type an Intent cannot carry` };
      continue;
    }
    shape[name] = required.has(name) ? field : field.optional();
  }
  for (const name of required) {
    if (!Object.hasOwn(shape, name) && !Object.hasOwn(properties, name)) {
      return { skip: `required parameter "${name}" is not declared in properties` };
    }
  }
  return { shape };
}

/**
 * One `IntentDef` per read-only tool of the port: the params come from the tool's `inputSchema` (strings,
 * numbers, integers and string enums; other optional parameters are left out, and a tool that requires one is
 * skipped, with `onSkip`), `queries` is `[{ path: tool.name }]` on `source`, and the canonical name is
 * `<source>.<segment>`, where the segment is the tool name lowercased with every character outside `[a-z0-9_]`
 * (`-`, `.`, ...) replaced by `_`, and prefixed `t_` if it would not start with a letter. Two tools that map to the
 * same canonical name make this throw.
 *
 * Silent limits: an optional parameter of a type an Intent cannot carry (boolean, array, object, a genuine union)
 * is left out, so it can never be set through an Intent.
 *
 * Actions never get an Intent: a `query://` ref, and so a read capability, can only ever be issued for an Intent's
 * resolved refs, which is what keeps a write tool from being read. A hand-written Intent must never point at an
 * action op (`port.actionOps`).
 */
export function createMcpIntents(port: McpDomainPort, options: McpIntentsOptions): IntentDef[] {
  if (!SOURCE_PATTERN.test(options.source)) {
    throw new Error(
      `createMcpIntents: source "${options.source}" must match ${SOURCE_PATTERN.source} to prefix an Intent name`,
    );
  }
  const intents: IntentDef[] = [];
  const names = new Map<string, string>();
  const queryOps = port.queryOps;
  for (const [name, tool] of port.tools) {
    if (!queryOps.has(name)) continue;
    const params = paramsFor(tool);
    if ("skip" in params) {
      options.onSkip?.({ tool: name, reason: params.skip });
      continue;
    }
    const canonical = `${options.source}.${canonicalSegment(name)}`;
    const previous = names.get(canonical);
    if (previous != null) {
      throw new Error(
        `createMcpIntents: tools "${previous}" and "${name}" map to the same canonical Intent name "${canonical}"`,
      );
    }
    names.set(canonical, name);
    const paramMap = Object.fromEntries(Object.keys(params.shape).map((key) => [key, key]));
    intents.push(
      defineIntent({
        canonical,
        description: tool.description ?? tool.title ?? tool.name,
        params: z.object(params.shape),
        examples: [],
        source: options.source,
        queries: [{ path: name, paramMap }],
      }).toIntentDef(),
    );
  }
  return intents;
}
