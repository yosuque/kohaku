import type { DomainPort, InvocationContext, JsonObject, OperationDescriptor } from "@kohaku-ui/spec-core";
import { OPERATIONS, type QueryArgs, shapeOf } from "./queries.js";
import type { SalesRepo } from "./repo.js";

/**
 * annotate's params schema (design.md #62): kohaku's own closed JSON Schema subset. `note` is required and
 * capped at 500 characters; `refs` (the invalidation-target $ref array actionEffects reads) is deliberately
 * left undeclared rather than `additionalProperties: false` -- validateActionParams only checks properties
 * it knows about unless additionalProperties is explicitly closed, so `refs` passes through unexamined.
 * Left as a plain object literal (not typed `ActionParamsSchema`) since `OperationDescriptor.paramsSchema`
 * is the wire-shaped `JsonValue`, which a named interface type does not structurally satisfy without a cast.
 */
const ANNOTATE_PARAMS_SCHEMA = {
  type: "object",
  properties: { note: { type: "string", maxLength: 500 } },
  required: ["note"],
};

/**
 * publish's params schema: the Publish button is an `action.button`, whose propsSchema carries no `action`,
 * so the action name travels in the event payload and the payload is exactly `{ action: "publish" }`.
 * Closing the schema (`additionalProperties: false`) makes the host answer 422 `ACTION_PARAMS_INVALID` for
 * any other key rather than hashing and approving an arbitrary payload for this "approve"-tier action.
 * Same plain-literal convention as ANNOTATE_PARAMS_SCHEMA above.
 */
const PUBLISH_PARAMS_SCHEMA = {
  type: "object",
  properties: { action: { type: "string", enum: ["publish"] } },
  required: ["action"],
  additionalProperties: false,
};

/**
 * DomainPort: the 5 sales-aggregation operations (= query://sales/{op}) + 2 demo write operations
 * (annotate: tier "confirm", publish: tier "approve" — design.md #62/#63's governed-actions demo). The API
 * is the product itself.
 */
export function createSalesDomainPort(repo: SalesRepo): DomainPort {
  return {
    async listOperations(): Promise<OperationDescriptor[]> {
      // annotate/publish are special-cased in invoke() below rather than OPERATIONS (they are writes, not
      // query:// reads), but they must still be listed here: hosts restrict capability write scopes to the
      // action names listOperations() enumerates, dropping any action.invoke the composed UI declares that
      // is not listed.
      return [
        ...Object.keys(OPERATIONS).map((name) => ({
          name,
          description: `sales ${name} query`,
          resultShape: shapeOf(name, {}) ?? undefined,
        })),
        {
          name: "annotate",
          description: "sales annotate (write): appends a review note and advances the data version",
          paramsSchema: ANNOTATE_PARAMS_SCHEMA,
          tier: "confirm",
          confirmMessage: "Save this note? It will be visible to everyone viewing these records.",
        },
        {
          name: "publish",
          description:
            "sales publish (write, demo only): marks the current sales report as published and advances the data version",
          paramsSchema: PUBLISH_PARAMS_SCHEMA,
          tier: "approve",
        },
      ];
    },
    async invoke(op: string, args: JsonObject, _ctx: InvocationContext): Promise<unknown> {
      // Demo of the direct write path (/binding/action): add a note and advance the data version.
      // actionEffects uses the response's dataVersion as the new version for refVersions (the small loop of the write loop).
      if (op === "annotate") {
        const note = typeof args["note"] === "string" ? (args["note"] as string) : "";
        return { ok: true, note, dataVersion: repo.annotate(note), notes: repo.notes.length };
      }
      // Demo of the "approve" tier (design.md #62/#63): a governance-gated write with no further side
      // effect declared beyond the version bump itself. The approver side is the console's Approvals tab
      // (design.md #72), which lists the refused attempts and mints the token; see also the "publish"
      // button's own doc comment in fixed-specs.ts.
      if (op === "publish") {
        return { ok: true, dataVersion: repo.publish(), published: repo.publishCount };
      }
      // OPERATIONS is a plain object, so if op is "toString"/"constructor", etc., an inherited method would be picked
      // up across the prototype chain. Restrict to its own properties.
      if (!Object.hasOwn(OPERATIONS, op)) throw new Error(`unknown operation: ${op}`);
      const operation = OPERATIONS[op as keyof typeof OPERATIONS];
      return operation(repo, args as QueryArgs);
    },
  };
}
