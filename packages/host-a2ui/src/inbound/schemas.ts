import { JsonObjectSchema, JsonValueSchema, MAX_JSON_OBJECT_DEPTH } from "@kohaku-ui/spec-core";
import { z } from "zod";
import type {
  A2uiBinding,
  A2uiComponent,
  A2uiComponentAction,
  A2uiFunctionCall,
  A2uiValue,
} from "../types.js";
import { A2uiIngestError } from "./reduce.js";
import { RESERVED_OBJECT_KEYS } from "./reserved-keys.js";

/**
 * Local equivalent of spec-core's own (unexported) `exceedsMaxJsonDepth` (`schema/json.ts`) — this
 * package's runtime dependency stays spec-core-only (see AGENTS.md), so the small, pure traversal is
 * mirrored here rather than exported from spec-core just for this one reuse; `MAX_JSON_OBJECT_DEPTH`
 * (spec-core's own public constant) is reused as the shared limit so the two packages agree on what "too
 * deep" means. Operates on `unknown` rather than `JsonValue` because it also guards `A2uiComponent`/
 * `A2uiFunctionCall`-shaped parsed values (plain objects that recurse via props/`args`), not just literal
 * JSON — a pathologically deep (but otherwise schema-valid) inbound message would otherwise cost this
 * profile's `fromA2ui` conversion and, later, `canonicalStringify`/lineage persistence unbounded recursion.
 */
function exceedsMaxDepth(value: unknown, limit: number, depth: number): boolean {
  if (Array.isArray(value)) {
    if (depth > limit) return true;
    return value.some((item) => exceedsMaxDepth(item, limit, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    if (depth > limit) return true;
    return Object.values(value).some((item) => exceedsMaxDepth(item, limit, depth + 1));
  }
  return false;
}

/**
 * Zod validation for **inbound** A2UI server→client messages (a third-party agent's `createSurface` /
 * `updateComponents` / `updateDataModel` / `deleteSurface`), the wire this ingest profile treats itself as
 * the "renderer" client for. Every field here is either one already modeled by `types.ts` (this profile's
 * own, previously-researched v0.9.1/v1.0 facts) or one recorded in
 * `kohaku-pm-2026-09-run/a2ui-v1.0-rc-facts.md`; nothing else is invented. Every object is validated with
 * either `.strict()` (structural/envelope keys — reject anything not on the known list) or `.catchall()`
 * (a component's inlined catalog props, which are open-ended by design — see `A2uiComponentSchema`).
 */

/** `{path}` data binding (RFC 6901). Same shape as `types.ts`'s `A2uiBinding`. */
export const A2uiBindingSchema: z.ZodType<A2uiBinding> = z.strictObject({ path: z.string() });

/**
 * The three-way value union (literal / binding / function call). `A2uiFunctionCallSchema` and this schema
 * are mutually recursive (a function call's `args` are themselves `A2uiValue`s), so this is wrapped in
 * `z.lazy` — evaluated only once both are defined, sidestepping the declaration-order issue a plain
 * `z.union` would hit.
 */
export const A2uiValueSchema: z.ZodType<A2uiValue> = z.lazy(() =>
  z.union([A2uiBindingSchema, A2uiFunctionCallSchema, JsonValueSchema]),
);

/** Client-side function call (shared shape for `action.functionCall` / a computed prop value). */
export const A2uiFunctionCallSchema: z.ZodType<A2uiFunctionCall> = z.strictObject({
  call: z.string().min(1),
  // Optional per the RC facts note's `action` shape (`{call, catalogId(optional), args}`).
  catalogId: z.string().min(1).optional(),
  args: z.record(z.string(), A2uiValueSchema),
  returnType: z.string().optional(),
});

/** `A2uiChildren`: a static id array, or the RC facts note's template-iteration form `{path, componentId}`. */
export const A2uiChildrenSchema = z.union([
  z.array(z.string()),
  z.strictObject({ path: z.string(), componentId: z.string() }),
]);

/** Event declaration on a firing component (`action.event`). */
export const A2uiEventSchema = z.strictObject({
  name: z.string().min(1),
  context: z.record(z.string(), A2uiValueSchema),
});

/** `A2uiComponentAction`: either a server-notifying `event`, or a client-local `functionCall`. */
export const A2uiComponentActionSchema: z.ZodType<A2uiComponentAction> = z.union([
  z.strictObject({ event: A2uiEventSchema }),
  z.strictObject({ functionCall: A2uiFunctionCallSchema }),
]);

/**
 * An A2UI component (flat adjacency-list form). The structural keys (id/component/children/child/action/
 * catalogId) are validated strictly by shape; everything else is a catalog-inlined prop (Text.text,
 * Row.justify, etc.) and is therefore intentionally open-ended (`.catchall`, not `.strict`) — the basic
 * catalog's own vocabulary is not part of the message envelope this schema is responsible for.
 *
 * The depth guard below (`exceedsMaxDepth`) is applied to the **whole parsed component** in one pass —
 * covering the catchall props, `action.functionCall.args`, and any function call nested inside another —
 * rather than separately to each nested schema (`A2uiValueSchema`/`A2uiFunctionCallSchema`'s own `args`).
 * A per-nested-schema check would restart counting from depth 1 at every nesting boundary and so would
 * *under*-count the true depth from this component's own root (e.g. two independently-"depth 30" structures
 * nested inside one another would each pass its own local check while the combined structure, at depth ~60,
 * should not) — checking the component as a whole is both simpler and the only way to get this right.
 */
export const A2uiComponentSchema: z.ZodType<A2uiComponent> = z
  .object({
    // Security: id becomes an object key (SurfaceState.components, keyed by id — see reduce.ts's
    // upsertComponents). A reserved name here (see RESERVED_OBJECT_KEYS's doc) would, on an ordinary
    // object, reassign that object's own prototype instead of storing a component.
    id: z
      .string()
      .min(1)
      .refine((id) => !RESERVED_OBJECT_KEYS.has(id), {
        message: 'component id must not be a reserved property name ("__proto__"/"constructor"/"prototype")',
      }),
    component: z.string().min(1),
    children: A2uiChildrenSchema.optional(),
    child: z.string().optional(),
    action: A2uiComponentActionSchema.optional(),
    catalogId: z.string().min(1).optional(),
  })
  .catchall(A2uiValueSchema)
  .superRefine((value, ctx) => {
    if (exceedsMaxDepth(value, MAX_JSON_OBJECT_DEPTH, 1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `component nesting exceeds the maximum depth (${MAX_JSON_OBJECT_DEPTH})`,
      });
    }
  });

/** `createSurface` (v0.9.1): surfaceId + catalogId required, matching `types.ts`'s `A2uiCreateSurface`. */
export const A2uiCreateSurfaceV091Schema = z.strictObject({
  surfaceId: z.string().min(1),
  catalogId: z.string().min(1),
  theme: JsonObjectSchema.optional(),
  sendDataModel: z.boolean().optional(),
});

/**
 * `createSurface` (v1.0 RC): per the facts note, `surfaceId` is the only required field — `catalogId` is
 * optional (a surface with no default catalog id is legal; every component/function call must then carry
 * its own `catalogId`, per the RC's resolution-order rule). `components`' `minItems: 1` (when present) is
 * carried over from `types.ts`'s `A2uiCreateSurfaceV1` doc comment (confirmed against the RC's JSON Schema
 * during the v1.0 research this profile already did; the facts note itself only records the field's
 * existence/optionality, not that constraint).
 */
export const A2uiCreateSurfaceV1Schema = z.strictObject({
  surfaceId: z.string().min(1),
  catalogId: z.string().min(1).optional(),
  components: z.array(A2uiComponentSchema).min(1).optional(),
  dataModel: JsonObjectSchema.optional(),
  sendDataModel: z.boolean().optional(),
});

/** `updateComponents`: unchanged between v0.9.1 and v1.0 (both require surfaceId + components). */
export const A2uiUpdateComponentsSchema = z.strictObject({
  surfaceId: z.string().min(1),
  components: z.array(A2uiComponentSchema),
});

/**
 * `updateDataModel` (v0.9.1): `value` is optional. `types.ts`'s existing `A2uiUpdateDataModel` doc comment
 * already records the working assumption this profile makes for that omission ("Omitting value deletes that
 * key") — carried over unchanged here since v0.9.1 fields are not the RC facts note's subject.
 */
export const A2uiUpdateDataModelV091Schema = z.strictObject({
  surfaceId: z.string().min(1),
  path: z.string().optional(),
  value: JsonValueSchema.superRefine((value, ctx) => {
    if (exceedsMaxDepth(value, MAX_JSON_OBJECT_DEPTH, 1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `updateDataModel value nesting exceeds the maximum depth (${MAX_JSON_OBJECT_DEPTH})`,
      });
    }
  }).optional(),
});

/** `updateDataModel` (v1.0 RC): per the facts note, `value` is required (no delete-by-omission in v1.0). */
export const A2uiUpdateDataModelV1Schema = z.strictObject({
  surfaceId: z.string().min(1),
  path: z.string().optional(),
  value: JsonValueSchema.superRefine((value, ctx) => {
    if (exceedsMaxDepth(value, MAX_JSON_OBJECT_DEPTH, 1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `updateDataModel value nesting exceeds the maximum depth (${MAX_JSON_OBJECT_DEPTH})`,
      });
    }
  }),
});

/** `deleteSurface`: unchanged between v0.9.1 and v1.0. */
export const A2uiDeleteSurfaceSchema = z.strictObject({ surfaceId: z.string().min(1) });

/** The 4 possible v0.9.1 envelopes: exactly `{version: "v0.9.1", <one message key>}`. */
export const InboundA2uiEnvelopeV091Schema = z.union([
  z.strictObject({ version: z.literal("v0.9.1"), createSurface: A2uiCreateSurfaceV091Schema }),
  z.strictObject({ version: z.literal("v0.9.1"), updateComponents: A2uiUpdateComponentsSchema }),
  z.strictObject({ version: z.literal("v0.9.1"), updateDataModel: A2uiUpdateDataModelV091Schema }),
  z.strictObject({ version: z.literal("v0.9.1"), deleteSurface: A2uiDeleteSurfaceSchema }),
]);

/** The 4 possible v1.0 RC envelopes: exactly `{version: "v1.0", <one message key>}`. */
export const InboundA2uiEnvelopeV1Schema = z.union([
  z.strictObject({ version: z.literal("v1.0"), createSurface: A2uiCreateSurfaceV1Schema }),
  z.strictObject({ version: z.literal("v1.0"), updateComponents: A2uiUpdateComponentsSchema }),
  z.strictObject({ version: z.literal("v1.0"), updateDataModel: A2uiUpdateDataModelV1Schema }),
  z.strictObject({ version: z.literal("v1.0"), deleteSurface: A2uiDeleteSurfaceSchema }),
]);

/** Any inbound A2UI server→client message this ingest profile accepts, across both wire versions. */
export const InboundA2uiEnvelopeSchema = z.union([
  InboundA2uiEnvelopeV091Schema,
  InboundA2uiEnvelopeV1Schema,
]);

export type InboundA2uiMessage = z.infer<typeof InboundA2uiEnvelopeSchema>;

/**
 * Security: the per-field `.superRefine` depth checks above (on `A2uiComponentSchema` and
 * `updateDataModel.value`) run only *after* zod has already recursively descended through the
 * mutually-recursive `A2uiValueSchema`/`JsonValueSchema` lazy union to validate the shape of everything
 * beneath that field — for a sufficiently deep (but otherwise shallow/narrow, so schema-cheap) input, that
 * descent itself is what exhausts the JS call stack (`RangeError: Maximum call stack size exceeded`),
 * *before* any `superRefine` ever runs to reject it. `exceedsMaxDepth` is safe against exactly this (it
 * stops recursing the instant `depth` exceeds `limit`, so its own stack usage is bounded to `limit + 1`
 * frames no matter how deep `value` actually is) — so `parseInboundA2uiMessage` runs it directly against the
 * **raw, not-yet-validated** message *before* handing anything to zod at all, closing the gap the
 * superRefine-only checks left open.
 *
 * The limit here is deliberately looser than `MAX_JSON_OBJECT_DEPTH` (not the same number): the raw message
 * still carries the *legitimate* envelope/message-body/component wrapping around a depth-guarded field, and
 * this check has no schema to tell those layers apart from the field's own content yet. The deepest such
 * wrapping in this schema is 5 levels — `{version, <messageKey>: {surfaceId, ..., components: [ {id,
 * component, ..., <prop>: <value>} ] }}` (envelope=1, message body=2, components array=3, component
 * object=4, prop value=5) — for a component prop nested inside a bundled `createSurface`/`updateComponents`;
 * `updateDataModel.value` needs only 3. `+ 8` leaves comfortable headroom above the 5 actually needed (for
 * future envelope shapes) while staying far below the depth (confirmed in the low thousands) at which zod's
 * own recursive descent risks a `RangeError` itself — this check only has to guarantee that *its own* limit
 * is never deep enough to reach that danger zone, not to enforce the precise per-field rule (that stays each
 * field's own `superRefine`, which still runs afterward and is what actually reports `MAX_JSON_OBJECT_DEPTH`
 * as the violated limit).
 */
export const MAX_RAW_ENVELOPE_DEPTH = MAX_JSON_OBJECT_DEPTH + 8;

/**
 * Parses and strictly validates one inbound A2UI message. Throws `A2uiIngestError` if `raw`'s nesting depth
 * alone makes it unsafe to even attempt schema validation (see `MAX_RAW_ENVELOPE_DEPTH`'s doc), or a
 * `z.ZodError` if it is not exactly one of the 8 known (version, messageKey) shapes above (including a
 * depth-guarded field individually exceeding `MAX_JSON_OBJECT_DEPTH`) — an ingest boundary is expected to
 * reject malformed/unknown third-party input rather than silently coerce or strip it.
 */
export function parseInboundA2uiMessage(raw: unknown): InboundA2uiMessage {
  if (exceedsMaxDepth(raw, MAX_RAW_ENVELOPE_DEPTH, 1)) {
    throw new A2uiIngestError(
      `inbound A2UI message nesting exceeds the maximum depth (${MAX_RAW_ENVELOPE_DEPTH}) checked before schema validation`,
    );
  }
  return InboundA2uiEnvelopeSchema.parse(raw);
}
