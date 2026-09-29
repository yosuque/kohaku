import { defineComponent } from "@kohaku-ui/registry";
import { parseSpec, type UISpec } from "@kohaku-ui/spec-core";
import { render, screen } from "@testing-library/react";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import { createCoreRegistry } from "../src/core/index.js";
import { ImplRegistry, implement, RendererProvider, SpecView, type TypedImplProps } from "../src/index.js";

const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L1", composedBy: "test", cache: "miss" } as const;

const badgeDef = defineComponent({
  type: "test.badge",
  version: "1.0.0",
  description: "Test fixture: a labeled badge with a tone.",
  propsSchema: z.object({
    label: z.string(),
    tone: z.enum(["info", "warn"]).default("info"),
  }),
  capabilities: { events: [], data: "none", children: "none" },
});

type BadgeProps = z.infer<typeof badgeDef.propsSchema>;

// Type-level check: `implement`'s Component prop is inferred from the schema (defaults applied by z.infer's
// output type), so a hand-written implementation never needs `node.props["x"] as T` to get a typed value.
expectTypeOf<BadgeProps>().toEqualTypeOf<{ label: string; tone: "info" | "warn" }>();

function Badge({ node, props }: TypedImplProps<BadgeProps>) {
  return (
    <span data-kohaku={node.id} data-tone={props.tone}>
      {props.label}
    </span>
  );
}

function badgeSpec(props: Record<string, unknown>): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    components: [{ id: "root", type: "test.badge", props }],
    events: [],
    provenance: PROVENANCE,
  });
}

function renderSpec(spec: UISpec, registry: ImplRegistry) {
  return render(
    <RendererProvider value={{ impls: registry, theme: {} }}>
      <SpecView spec={spec} />
    </RendererProvider>,
  );
}

describe("implement / ImplRegistry.use", () => {
  it("registers under the definition's own type/version and passes parsed props through", () => {
    const registry = new ImplRegistry().use(implement(badgeDef, Badge));
    renderSpec(badgeSpec({ label: "Shipped" }), registry);
    const el = screen.getByText("Shipped");
    // The default from propsSchema was applied (parsed.data, not the raw node.props).
    expect(el.getAttribute("data-tone")).toBe("info");
  });

  it("still exposes the type under registry.get / supports (parity with .register)", () => {
    const registry = new ImplRegistry().use(implement(badgeDef, Badge));
    expect(registry.get("test.badge")).toBeTypeOf("function");
    expect(registry.supports()).toEqual({ "test.badge": "^1.0.0" });
  });

  it("does not disturb registrations made via the legacy .register", () => {
    const registry = createCoreRegistry().use(implement(badgeDef, Badge));
    expect(registry.get("text.heading")).toBeTypeOf("function");
    expect(registry.get("test.badge")).toBeTypeOf("function");
  });

  it("warns and falls back to raw (unvalidated) props on a schema mismatch, outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = new ImplRegistry().use(implement(badgeDef, Badge));
      // `label` is missing (required by the schema) — validation fails, but rendering still proceeds
      // (fail-open): Badge receives the raw, unvalidated node.props instead.
      renderSpec(badgeSpec({}), registry);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("test.badge");
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("parses a props object once and warns once, however many times the Spec re-renders", () => {
    vi.stubEnv("NODE_ENV", "test");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parse = vi.spyOn(badgeDef.propsSchema, "safeParse");
    try {
      const registry = new ImplRegistry().use(implement(badgeDef, Badge));
      const spec = badgeSpec({}); // missing required `label`
      const ui = (
        <RendererProvider value={{ impls: registry, theme: {} }}>
          <SpecView spec={spec} />
        </RendererProvider>
      );
      const { rerender } = render(ui);
      rerender(ui);
      rerender(ui);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      // A replaced Spec carries a new props object, which is parsed (and warned about) afresh.
      rerender(
        <RendererProvider value={{ impls: registry, theme: {} }}>
          <SpecView spec={badgeSpec({})} />
        </RendererProvider>,
      );
      expect(parse).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      parse.mockRestore();
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("skips only the warning (not the parsing) on a mismatch in a NODE_ENV=production build by default", () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = new ImplRegistry().use(implement(badgeDef, Badge));
      // `label` is missing — safeParse still runs and still fails, but no console.warn in production;
      // rendering proceeds fail-open with the raw props, same as outside production.
      const { container } = renderSpec(badgeSpec({}), registry);
      expect(warn).not.toHaveBeenCalled();
      expect(container.querySelector('[data-kohaku="root"]')).not.toBeNull();
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("applies propsSchema defaults even in a NODE_ENV=production build (parsing is unconditional)", () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = new ImplRegistry().use(implement(badgeDef, Badge));
      // `tone` is omitted but has a Zod default — if production skipped safeParse entirely (the bug this
      // guards against), Badge would receive raw props without a `tone` key at all instead of "info".
      renderSpec(badgeSpec({ label: "Steady" }), registry);
      expect(screen.getByText("Steady").getAttribute("data-tone")).toBe("info");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("{ validate: false } suppresses the warning even outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = new ImplRegistry().use(implement(badgeDef, Badge, { validate: false }));
      renderSpec(badgeSpec({}), registry);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("{ validate: true } forces the warning even in a NODE_ENV=production build", () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = new ImplRegistry().use(implement(badgeDef, Badge, { validate: true }));
      renderSpec(badgeSpec({}), registry);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
