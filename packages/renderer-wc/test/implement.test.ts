import { defineComponent } from "@kohaku-ui/registry";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { implementWc, type TypedPartBuilder } from "../src/implement.js";
import { defineKohakuSurface, type KohakuSurface } from "../src/index.js";
import { buildSpec, byKohaku, tick } from "./util.js";

defineKohakuSurface();

const badgeDef = defineComponent({
  type: "test.badge",
  version: "1.0.0",
  description: "Test fixture: a labeled badge with a tone.",
  propsSchema: z.object({ label: z.string(), tone: z.enum(["info", "warn"]).default("info") }),
  capabilities: { events: [], data: "none", children: "none" },
});

const badgeBuilder: TypedPartBuilder<{ label: string; tone: "info" | "warn" }> = (
  _rt,
  parent,
  node,
  props,
) => {
  const el = document.createElement("span");
  el.dataset["kohaku"] = node.id;
  el.dataset["tone"] = props.tone;
  el.textContent = props.label;
  parent.appendChild(el);
  return () => el.remove();
};

function badgeSpec(props: Record<string, unknown>) {
  return buildSpec({ components: [{ id: "root", type: "test.badge", props }] });
}

describe("registerPart / implementWc", () => {
  it("renders a product-specific part registered before spec is assigned", async () => {
    const surface = document.createElement("kohaku-surface") as KohakuSurface;
    document.body.appendChild(surface);
    const entry = implementWc(badgeDef, badgeBuilder);
    surface.registerPart(entry.type, entry.version, entry.builder);
    surface.spec = badgeSpec({ label: "Shipped" });
    await tick();
    const el = byKohaku(surface, "root")!;
    expect(el.tagName).toBe("SPAN");
    expect(el.textContent).toBe("Shipped");
    expect(el.dataset["tone"]).toBe("info");
    expect(surface.getPartVersion("test.badge")).toBe("1.0.0");
  });

  it("rebuilds an already-mounted Spec when a part is registered afterwards", async () => {
    const surface = document.createElement("kohaku-surface") as KohakuSurface;
    document.body.appendChild(surface);
    surface.spec = badgeSpec({ label: "Shipped" });
    await tick();
    // Before registration: no builder is registered for "test.badge" yet (unimplemented-type placeholder).
    expect(byKohaku(surface, "root")).toBeNull();

    const entry = implementWc(badgeDef, badgeBuilder);
    surface.registerPart(entry.type, entry.version, entry.builder);
    await tick();
    const el = byKohaku(surface, "root")!;
    expect(el.tagName).toBe("SPAN");
    expect(el.textContent).toBe("Shipped");
  });

  it("warns and falls back to raw (unvalidated) props on a schema mismatch, outside production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const surface = document.createElement("kohaku-surface") as KohakuSurface;
      document.body.appendChild(surface);
      const entry = implementWc(badgeDef, badgeBuilder);
      surface.registerPart(entry.type, entry.version, entry.builder);
      surface.spec = badgeSpec({}); // missing required `label`
      await tick();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("test.badge");
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("skips validation (and the warning) in a NODE_ENV=production build by default", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const surface = document.createElement("kohaku-surface") as KohakuSurface;
      document.body.appendChild(surface);
      const entry = implementWc(badgeDef, badgeBuilder);
      surface.registerPart(entry.type, entry.version, entry.builder);
      surface.spec = badgeSpec({});
      await tick();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
