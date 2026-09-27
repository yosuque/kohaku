// Parity for a product-specific part registered via implement/implementWc (design.md #68): given the same
// ComponentDefinition, a typed React component (registered with `implement` + `ImplRegistry.use`) and a
// typed WC builder (registered with `implementWc` + `<kohaku-surface>.registerPart`) must render the same
// semantic DOM for the same Spec — proving the typed registration path preserves the A2 parity guarantee,
// not just the untyped `.register()` / raw `PartBuilder` path the rest of this directory already covers.

import { defineComponent } from "@kohaku-ui/registry";
import { implement, type TypedImplProps } from "@kohaku-ui/renderer-react";
import { createCoreRegistry } from "@kohaku-ui/renderer-react/core";
import { parseSpec, type UISpec } from "@kohaku-ui/spec-core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { implementWc, type TypedPartBuilder } from "../../src/implement.js";
import { cleanupPair, renderPair } from "./render-both.js";

const INTENT = { canonical: "parity.custom_part", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L1", composedBy: "parity", cache: "miss" } as const;

const badgeDef = defineComponent({
  type: "parity.badge",
  version: "1.0.0",
  description: "Parity fixture: a labeled badge with a tone.",
  propsSchema: z.object({
    label: z.string(),
    tone: z.enum(["info", "warn"]).default("info"),
  }),
  capabilities: { events: [], data: "none", children: "none" },
});

type BadgeProps = z.infer<typeof badgeDef.propsSchema>;

function ReactBadge({ node, props }: TypedImplProps<BadgeProps>) {
  return (
    <span data-kohaku={node.id} data-tone={props.tone}>
      {props.label}
    </span>
  );
}

const wcBadgeBuilder: TypedPartBuilder<BadgeProps> = (_rt, parent, node, props) => {
  const el = document.createElement("span");
  el.dataset["kohaku"] = node.id;
  el.dataset["tone"] = props.tone;
  el.textContent = props.label;
  parent.appendChild(el);
  return () => el.remove();
};

function badgeSpec(props: Record<string, unknown>): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    components: [{ id: "root", type: "parity.badge", props }],
    events: [],
    provenance: PROVENANCE,
  });
}

describe("custom part parity: implement (React) ≡ implementWc (WC)", () => {
  afterEach(() => cleanupPair());

  it("renders the same DOM for a product-specific part with an explicit tone", async () => {
    const { react, wc } = await renderPair(badgeSpec({ label: "Shipped", tone: "warn" }), {
      impls: () => createCoreRegistry().use(implement(badgeDef, ReactBadge)),
      registerParts: (surface) => {
        const entry = implementWc(badgeDef, wcBadgeBuilder);
        surface.registerPart(entry.type, entry.version, entry.builder);
      },
    });
    expect(wc).toEqual(react);
  });

  it("renders the same DOM when the schema's default (tone) fills the prop", async () => {
    const { react, wc } = await renderPair(badgeSpec({ label: "Steady" }), {
      impls: () => createCoreRegistry().use(implement(badgeDef, ReactBadge)),
      registerParts: (surface) => {
        const entry = implementWc(badgeDef, wcBadgeBuilder);
        surface.registerPart(entry.type, entry.version, entry.builder);
      },
    });
    expect(wc).toEqual(react);
    expect(react.attrs["data-tone"]).toBe("info");
  });
});
