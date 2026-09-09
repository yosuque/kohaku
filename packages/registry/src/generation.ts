import type { ComponentNode, EventBinding, JsonObject, JsonValue } from "@kohaku-ui/spec-core";
import type { ResolvedCatalog } from "./catalog.js";
import { cachedGenerationPropsSchema, stripNulls } from "./json-schema.js";

export interface GeneratedDraft {
  components: ComponentNode[];
  events: EventBinding[];
}

export interface GenerationSchema {
  /** JSON Schema already converted to the provider lowest common denominator (strict-mode compatible) */
  jsonSchema: Record<string, unknown>;
  /** LLM-generated object → draft (null removal / payload pairs → object) */
  decode(raw: unknown): GeneratedDraft;
}

const ID_PATTERN = "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$";

/**
 * Parts that always remain in the generation vocabulary even when candidate narrowing (includeTypes)
 * is specified. layout.stack is the root container and presentMarkdown is the terminal of the
 * deterministic fallback; if either disappears from the vocabulary, the L1 repair loop no longer holds
 * structurally (the root cannot be built / a fallback Spec cannot be produced). Always unioned in as a
 * guardrail.
 */
const GENERATION_ALWAYS_INCLUDED = ["layout.stack", "presentMarkdown"] as const;

/** Optional settings for buildGenerationSchema. */
export interface BuildGenerationOptions {
  /**
   * Allowlist of component types to include in the generation vocabulary (candidate narrowing).
   * - undefined: all of them (the default, excluding generation:"excluded").
   * - when specified: only these types + the guardrails (layout.stack / presentMarkdown), always unioned.
   * - if none of the specified types exists in the catalog, fall back to all of them (prevents an empty
   *   vocabulary that would make repair impossible).
   */
  includeTypes?: readonly string[];
}

/**
 * Determines the component types that actually appear in the generation vocabulary (the single source
 * that keeps buildGenerationSchema and the prompt in agreement on the vocabulary).
 * Finalized in this order: exclude generation:"excluded" → narrow by includeTypes → union guardrails →
 * fall back on zero matches.
 */
export function selectGenerationTypes(catalog: ResolvedCatalog, includeTypes?: readonly string[]): string[] {
  const listed = catalog.list().filter((def) => def.generation !== "excluded");
  if (includeTypes == null) return listed.map((def) => def.type);
  // If none of the specified types exists in the catalog, fall back to all of them (avoids an empty vocabulary).
  const requested = listed.filter((def) => includeTypes.includes(def.type));
  if (requested.length === 0) return listed.map((def) => def.type);
  const allowed = new Set<string>([...includeTypes, ...GENERATION_ALWAYS_INCLUDED]);
  return listed.filter((def) => allowed.has(def.type)).map((def) => def.type);
}

/**
 * Dynamically builds the schema for L1 constrained generation.
 * - A variant per component type (anyOf). props are derived from the catalog's true schema.
 * - The data $ref is pinned to an enum of QueryHandle URIs resolved by the SemanticPort so the LLM
 *   cannot forge unknown references (schema-level enforcement of the reference-passing principle).
 * - The event payload is a {key,value} pair array (strict mode disallows free-form objects).
 *
 * Client-local state (kohaku >= 0.2 state / visibleWhen / emit:"state.set") and two-way binding
 * (data.bind / control.select) are **not put into the generation vocabulary**. Because a node variant
 * is additionalProperties:false, neither visibleWhen nor data.bind can be output structurally (data is
 * `{$ref: enum}` + additionalProperties:false, which seals off the bind keys), and the event emit enum
 * does not include state.set either. control.select is generation:"excluded" and drops out of the
 * variants. Likewise, the overlay parts (overlay.dialog / overlay.toast) are state-linked parts that
 * declare their open/close via state + visibleWhen, so they are generation:"excluded" (dropped from the
 * variants). These are intended for L0 fixed Specs, hand-written Specs, and promotion templates;
 * opening them to L1 generation is left as a separate decision (a structural containment that does not
 * let the LLM decide the bind value-range allowlist).
 */
export function buildGenerationSchema(
  catalog: ResolvedCatalog,
  dataRefs: string[],
  options?: BuildGenerationOptions,
): GenerationSchema {
  // In addition to excluding generation:"excluded" (runtime-only parts such as ui.loading), narrow the
  // candidates when includeTypes is specified. selectGenerationTypes is the single source of the types
  // that actually remain (keeping prompt and vocabulary in agreement). Combined with
  // additionalProperties:false, the LLM cannot output anything other than these structurally.
  const included = new Set(selectGenerationTypes(catalog, options?.includeTypes));
  const variants = catalog
    .list()
    .filter((def) => included.has(def.type))
    .map((def) => {
      const props = cachedGenerationPropsSchema(def);
      const properties: Record<string, unknown> = {
        id: { type: "string", pattern: ID_PATTERN },
        type: { const: def.type },
        props,
      };
      const required = ["id", "type", "props"];

      if (def.capabilities.children === "optional") {
        properties["children"] = {
          anyOf: [{ type: "array", items: { type: "string", pattern: ID_PATTERN } }, { type: "null" }],
        };
        required.push("children");
      }
      if (def.capabilities.data !== "none" && dataRefs.length > 0) {
        const refSchema = {
          type: "object",
          properties: { $ref: { type: "string", enum: dataRefs } },
          required: ["$ref"],
          additionalProperties: false,
        };
        properties["data"] =
          def.capabilities.data === "required" ? refSchema : { anyOf: [refSchema, { type: "null" }] };
        required.push("data");
      }

      return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
        description: `${def.type}@${def.version}: ${def.description}`,
      };
    });

  const eventSchema = {
    type: "object",
    properties: {
      on: { type: "string", description: 'componentId.eventName format (e.g. "table1.rowClick")' },
      emit: { type: "string", enum: ["intent.patch", "intent.replace", "action.invoke"] },
      payload: {
        type: "array",
        items: {
          type: "object",
          properties: { key: { type: "string" }, value: { type: "string" } },
          required: ["key", "value"],
          additionalProperties: false,
        },
      },
    },
    required: ["on", "emit", "payload"],
    additionalProperties: false,
  };

  const jsonSchema = {
    type: "object",
    properties: {
      components: { type: "array", items: { anyOf: variants } },
      events: { type: "array", items: eventSchema },
    },
    required: ["components", "events"],
    additionalProperties: false,
  };

  return {
    jsonSchema,
    decode(raw: unknown): GeneratedDraft {
      // Defensive validation: on the prompt-JSON fallback path (the default
      // KOHAKU_LLM_STRUCTURED_MODE=auto), jsonSchema is not enforced, so malformed LLM output
      // (components/events not an array, an element not an object, on/emit not a string) reaches decode
      // unvalidated. Throw a descriptive Error here so the caller (l1-generate) can pick it up as a
      // repair issue (a bare .map / property access would raise a TypeError, which would turn the whole
      // compose into INTERNAL / a host 500).
      const obj = (raw ?? {}) as { components?: unknown; events?: unknown };
      const rawComponents = obj.components ?? [];
      if (!Array.isArray(rawComponents)) {
        throw new Error("generated draft components is not an array");
      }
      const components = rawComponents.map((c, i): ComponentNode => {
        if (c == null || typeof c !== "object" || Array.isArray(c)) {
          throw new Error(`generated draft components[${i}] is not an object`);
        }
        const node = stripNulls(c) as ComponentNode;
        return { ...node, props: (node.props ?? {}) as JsonObject };
      });
      const rawEvents = obj.events ?? [];
      if (!Array.isArray(rawEvents)) {
        throw new Error("generated draft events is not an array");
      }
      const events: EventBinding[] = rawEvents.map((e, i): EventBinding => {
        if (e == null || typeof e !== "object" || Array.isArray(e)) {
          throw new Error(`generated draft events[${i}] is not an object`);
        }
        const ev = e as { on?: unknown; emit?: unknown; payload?: unknown };
        // An out-of-enum emit (e.g. "intent.foo") is "a string but invalid", so decode lets it through
        // and defers to the EventBinding Zod validation in collectIssues. Here we reject only
        // non-strings that would raise a TypeError.
        if (typeof ev.on !== "string") {
          throw new Error(`generated draft events[${i}].on is not a string`);
        }
        if (typeof ev.emit !== "string") {
          throw new Error(`generated draft events[${i}].emit is not a string`);
        }
        const payload = Array.isArray(ev.payload) ? ev.payload : [];
        return {
          on: ev.on,
          emit: ev.emit as EventBinding["emit"],
          payload: Object.fromEntries(
            payload.map((p) => {
              const pair = (p ?? {}) as { key?: unknown; value?: unknown };
              return [String(pair.key), pair.value as JsonValue];
            }),
          ),
        };
      });
      return { components, events };
    },
  };
}
