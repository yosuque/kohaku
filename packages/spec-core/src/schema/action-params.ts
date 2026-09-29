import { z } from "zod";

/**
 * kohaku's own JSON Schema *subset* for `OperationDescriptor.paramsSchema` (design.md #62: Action
 * parameters are validated against this subset, not arbitrary JSON Schema / Zod). The keyword set is
 * deliberately small and closed:
 *
 * - `type`, `properties`, `required`, `additionalProperties` (only literal `false`), `enum`,
 *   `minimum` / `maximum`, `minLength` / `maxLength`, `items`, `maxItems`, `x-message`.
 * - No `pattern`: regular expressions are excluded on purpose, both to avoid ReDoS from an
 *   operator-authored schema and because JS (`RegExp`) and Python (`re`) regex dialects are not
 *   byte-for-byte compatible, which would break the TS/Python golden-parity guarantee this subset
 *   exists to provide.
 * - No `oneOf` / `anyOf` / `$ref` / numeric `multipleOf` / etc. — this is intentionally not "JSON
 *   Schema", only the fragment of it needed to validate a flat-ish action payload.
 *
 * `z.strictObject` rejects any key outside this list, so parsing a `paramsSchema` against
 * `ActionParamsSchemaSchema` *is* the "unknown keyword -> exception" check (design.md #62); host-core's
 * `createOperationIndex` runs this parse once per operation at attach time, not per request.
 *
 * This is a meta-schema (validates the *shape of a schema*), not a Zod schema for a wire value that
 * itself needs `spec/schemas` generation — `paramsSchema` travels inside the additive `actions` map of
 * a compose response (design.md #64: outside the UISpec, next to the capability), not inside the
 * UISpec/SpecPatch/FixationRecord/LineageEventRecord/PromotionState/PolicyFile documents that
 * `spec/scripts/generate-schemas.ts` renders.
 */
export interface ActionParamsSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  properties?: Record<string, ActionParamsSchema>;
  required?: string[];
  additionalProperties?: false;
  enum?: (string | number | boolean | null)[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: ActionParamsSchema;
  maxItems?: number;
  /** Overrides every issue's `message` produced against this schema node (and its descendants' own defaults). */
  "x-message"?: string;
}

/**
 * The Zod form of {@link ActionParamsSchema}. `z.lazy` breaks the recursion through `properties` /
 * `items`. Every level is `strictObject`, so an unknown keyword anywhere in the tree fails `.parse`
 * with a `ZodError` naming its path.
 */
export const ActionParamsSchemaSchema: z.ZodType<ActionParamsSchema> = z.lazy(() =>
  z.strictObject({
    type: z.enum(["object", "array", "string", "number", "integer", "boolean"]),
    properties: z.record(z.string(), ActionParamsSchemaSchema).optional(),
    required: z.array(z.string()).optional(),
    additionalProperties: z.literal(false).optional(),
    enum: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    items: ActionParamsSchemaSchema.optional(),
    maxItems: z.number().int().nonnegative().optional(),
    "x-message": z.string().optional(),
  }),
);
