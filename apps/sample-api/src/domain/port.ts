import type { DomainPort, InvocationContext, JsonObject, OperationDescriptor } from "@kohaku-ui/spec-core";
import { OPERATIONS, type QueryArgs, shapeOf } from "./queries.js";
import type { SalesRepo } from "./repo.js";

/**
 * DomainPort: the 5 sales-aggregation operations (= query://sales/{op}) + 1 demo write operation (annotate).
 * The API is the product itself.
 */
export function createSalesDomainPort(repo: SalesRepo): DomainPort {
  return {
    async listOperations(): Promise<OperationDescriptor[]> {
      // annotate is special-cased in invoke() below rather than OPERATIONS (it is a write, not a query://
      // read), but it must still be listed here: hosts restrict capability write scopes to the action names
      // listOperations() enumerates, dropping any action.invoke the composed UI declares that is not listed.
      return [
        ...Object.keys(OPERATIONS).map((name) => ({
          name,
          description: `sales ${name} query`,
          resultShape: shapeOf(name, {}) ?? undefined,
        })),
        {
          name: "annotate",
          description: "sales annotate (write): appends a review note and advances the data version",
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
      // OPERATIONS is a plain object, so if op is "toString"/"constructor", etc., an inherited method would be picked
      // up across the prototype chain. Restrict to its own properties.
      if (!Object.hasOwn(OPERATIONS, op)) throw new Error(`unknown operation: ${op}`);
      const operation = OPERATIONS[op as keyof typeof OPERATIONS];
      return operation(repo, args as QueryArgs);
    },
  };
}
