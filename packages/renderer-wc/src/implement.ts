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
 * `def.propsSchema.safeParse` always runs, in every environment — not just outside a `NODE_ENV=production`
 * build — because it is also what materializes a `.default()`-ed prop (or any other Zod transform) the Spec
 * omits; skipping it in production would silently make `builder` see `undefined` for a prop its type says
 * is always present. On success, `builder` receives `parsed.data`; on failure it receives the raw
 * (unvalidated) `node.props` instead, matching the renderer's general fail-open policy. Only the
 * **diagnostic** — a `console.warn` on a mismatch — is gated by environment: by default it fires outside a
 * `NODE_ENV=production` build (see `isDevEnvironment`); pass `{ validate }` to force it on or off
 * regardless of environment.
 */
export function implementWc<P extends z.ZodObject>(
  def: ComponentDefinition<P>,
  builder: TypedPartBuilder<z.infer<P>>,
  options?: { validate?: boolean },
): PartEntry {
  const shouldWarn = options?.validate ?? isDevEnvironment();
  const wrapped: PartBuilder = (rt, parent, node, row) => {
    const parsed = def.propsSchema.safeParse(node.props);
    let props: z.infer<P>;
    if (parsed.success) {
      props = parsed.data as z.infer<P>;
    } else {
      props = node.props as z.infer<P>;
      if (shouldWarn) {
        console.warn(
          `[kohaku] component "${def.type}" (node ${node.id}) received props that don't match its schema: ${parsed.error.message}`,
        );
      }
    }
    return builder(rt, parent, node, props, row);
  };
  return { type: def.type, version: def.version, builder: wrapped };
}
