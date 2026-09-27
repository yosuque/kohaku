import type { ComponentDefinition } from "@kohaku-ui/registry";
import { isDevEnvironment } from "@kohaku-ui/renderer-core";
import type { ComponentNode, JsonObject } from "@kohaku-ui/spec-core";
import type { z } from "zod";
import type { PartBuilder, RenderRuntime, Teardown } from "./types.js";

/**
 * A part builder with typed props, taken from a `ComponentDefinition`'s `propsSchema` (design.md #68).
 * Same shape as `PartBuilder`, with `props` added between `node` and `row`, so a product's builder never
 * has to read `node.props["x"] as T` itself — the WC counterpart of renderer-react's typed `Component`.
 */
export type TypedPartBuilder<P> = (
  rt: RenderRuntime,
  parent: ParentNode,
  node: ComponentNode,
  props: P,
  row: JsonObject | null,
) => Teardown;

/** Registration triple returned by `implementWc`, passed to `<kohaku-surface>.registerPart`. */
export interface PartEntry {
  type: string;
  version: string;
  builder: PartBuilder;
}

/**
 * Wraps a typed `TypedPartBuilder` into a plain `PartBuilder` bound to `def`'s own type and version — the
 * WC counterpart of renderer-react's `implement` (design.md #68). Usage:
 * ```ts
 * const entry = implementWc(myPartDef, (rt, parent, node, props, row) => { ... });
 * surface.registerPart(entry.type, entry.version, entry.builder);
 * ```
 *
 * By default, outside a `NODE_ENV=production` build (see `isDevEnvironment`), the node's `props` are
 * validated against `def.propsSchema` before every mount; a mismatch is reported via `console.warn` and
 * the wrapped builder still runs with the raw (unvalidated) props, matching the renderer's general
 * fail-open policy. Pass `{ validate }` to force the check on or off regardless of environment.
 */
export function implementWc<P extends z.ZodObject>(
  def: ComponentDefinition<P>,
  builder: TypedPartBuilder<z.infer<P>>,
  options?: { validate?: boolean },
): PartEntry {
  const shouldValidate = options?.validate ?? isDevEnvironment();
  const wrapped: PartBuilder = (rt, parent, node, row) => {
    let props = node.props as z.infer<P>;
    if (shouldValidate) {
      const parsed = def.propsSchema.safeParse(node.props);
      if (parsed.success) {
        props = parsed.data as z.infer<P>;
      } else {
        console.warn(
          `[kohaku] component "${def.type}" (node ${node.id}) received props that don't match its schema: ${parsed.error.message}`,
        );
      }
    }
    return builder(rt, parent, node, props, row);
  };
  return { type: def.type, version: def.version, builder: wrapped };
}
