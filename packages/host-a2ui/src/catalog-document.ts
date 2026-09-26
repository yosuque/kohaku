import type { JsonObject } from "@kohaku-ui/spec-core";
import { KOHAKU_SET_STATE_FUNCTION } from "./to-a2ui.js";

/**
 * Builds kohaku's own A2UI v1.0 RC catalog document (the thing a `catalogId` resolves to): the
 * `functions` a real A2UI v1.0 client would need to look up {@link KOHAKU_SET_STATE_FUNCTION} against, plus
 * a minimal `components` declaration for kohaku's own (non-basic-catalog) component types.
 *
 * This profile never *serves* this document over any transport (kohaku has no catalog-hosting endpoint);
 * it exists so a host that does stand up `catalogId` resolution (e.g. `KOHAKU_CATALOG_ID` served as a
 * static file) has something schema-shaped to serve, generated from the same constants `to-a2ui.ts` stamps
 * onto the wire (`KOHAKU_CATALOG_ID`, `KOHAKU_SET_STATE_FUNCTION`) rather than hand-duplicated.
 *
 * The RC facts note (`kohaku-pm-2026-09-run/a2ui-v1.0-rc-facts.md`) confirms the **function** declaration
 * shape (`{functions: {<name>: {type, returnType, allowedCallers, properties: {call, args}}}}`) but says
 * nothing about a catalog's **component** declaration shape — so `components` below is deliberately minimal
 * (just enough for `catalogId` resolution to have an entry per type) and NOT a claim about the real shape;
 * verify against the A2UI v1.0 spec before treating it as more than a placeholder.
 *
 * `callRendererFunction` (the server→renderer direction of the v1.0 RC's function-call channel) is not
 * modeled here: kohaku has no renderer-side catalog function for an agent to invoke (see the package
 * README's "A2UI v1.0 RC support" section), so there is nothing to declare a `callRendererFunction` for.
 */
export interface KohakuCatalogDocumentOptions {
  /**
   * kohaku component types to list under `components` — typically every verbatim (non-basic-mapped) type a
   * caller's own registry defines (e.g. `presentChart`, `presentSpreadsheet`, `layout.grid`), the same set
   * `verbatimComponent` (`to-a2ui.ts`) stamps `catalogId` onto in `catalogMode: "split"`. Defaults to `[]`.
   */
  componentTypes?: string[];
}

/** Builds the kohaku catalog document (see the module doc comment above). */
export function buildKohakuCatalogDocument(opts?: KohakuCatalogDocumentOptions): JsonObject {
  const componentTypes = opts?.componentTypes ?? [];
  return {
    functions: {
      [KOHAKU_SET_STATE_FUNCTION]: {
        type: "object",
        // verify against the A2UI v1.0 spec: the facts note lists returnType's possible values
        // ("validationResult|string|number|…") but not which one a fire-and-forget, no-meaningful-return
        // function like kohaku.setState should declare. "validationResult" is the closest fit pending
        // confirmation against the real spec.
        returnType: "validationResult",
        allowedCallers: "rendererOnly",
        properties: {
          call: { const: KOHAKU_SET_STATE_FUNCTION },
          args: {
            type: "object",
            properties: {
              key: { type: "string" },
              // No narrower type: state.set's value is an arbitrary JSON value (spec-core's
              // EventBindingSchema constrains payload.value no further than JsonValueSchema either).
              value: {},
            },
          },
        },
      },
    },
    // Minimal placeholder per type (see the module doc comment's "verify against the A2UI v1.0 spec" note):
    // enough for catalogId resolution to have an entry, not a full JSON Schema of each type's props.
    components: Object.fromEntries(componentTypes.map((type) => [type, { type: "object" }])),
  };
}
