import type { UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  buildGenerationSchema,
  coreCatalog,
  negotiate,
  resolveCatalog,
  selectGenerationTypes,
} from "../src/index.js";

const catalog = resolveCatalog(coreCatalog);

describe("catalog registration of overlay parts", () => {
  it("overlay.dialog / overlay.toast resolve at 1.0.0 and default props are filled", () => {
    const dialog = catalog.get("overlay.dialog")!;
    expect(dialog.version).toBe("1.0.0");
    // variant defaults to default, children is optional, and it has the close event.
    expect((dialog.propsSchema.parse({ title: "Confirm" }) as { variant: string }).variant).toBe("default");
    expect(dialog.capabilities.children).toBe("optional");
    expect(dialog.capabilities.events).toEqual(["close"]);

    const toast = catalog.get("overlay.toast")!;
    expect(toast.version).toBe("1.0.0");
    // tone defaults to info, durationMs is optional, no children, and it has the dismiss event.
    expect((toast.propsSchema.parse({ message: "Saved" }) as { tone: string }).tone).toBe("info");
    expect(toast.capabilities.children).toBe("none");
    expect(toast.capabilities.events).toEqual(["dismiss"]);
  });

  it("both parts are excluded from the L1 generation vocabulary (generation:excluded)", () => {
    expect(catalog.get("overlay.dialog")!.generation).toBe("excluded");
    expect(catalog.get("overlay.toast")!.generation).toBe("excluded");

    // Appears in neither selectGenerationTypes nor buildGenerationSchema.
    const types = selectGenerationTypes(catalog);
    expect(types).not.toContain("overlay.dialog");
    expect(types).not.toContain("overlay.toast");
    const { jsonSchema } = buildGenerationSchema(catalog, ["query://sales/summary?fy=2026"]);
    const text = JSON.stringify(jsonSchema);
    expect(text).not.toContain("overlay.dialog");
    expect(text).not.toContain("overlay.toast");
  });

  it("close / dismiss are declarable events, unsupported events are EVENT_NOT_SUPPORTED", () => {
    const { issues } = catalog.validate(
      [
        { id: "root", type: "layout.stack", props: {}, children: ["d", "t"] },
        { id: "d", type: "overlay.dialog", props: { title: "Confirm" } },
        { id: "t", type: "overlay.toast", props: { message: "Done" } },
      ],
      [
        { on: "d.close", emit: "state.set", payload: { key: "open", value: false } },
        { on: "t.dismiss", emit: "state.set", payload: { key: "toastOpen", value: false } },
      ],
    );
    // close / dismiss are in capabilities.events, so EVENT_NOT_SUPPORTED is not raised.
    expect(issues.filter((i) => i.code === "EVENT_NOT_SUPPORTED")).toEqual([]);

    const bad = catalog.validate(
      [{ id: "d", type: "overlay.dialog", props: { title: "Confirm" } }],
      [{ on: "d.dismiss", emit: "state.set", payload: { key: "open", value: false } }],
    );
    expect(bad.issues.some((i) => i.code === "EVENT_NOT_SUPPORTED")).toBe(true);
  });

  it("missing title / unknown variant is PROPS_INVALID", () => {
    const { issues } = catalog.validate([
      { id: "root", type: "layout.stack", props: {}, children: ["d"] },
      { id: "d", type: "overlay.dialog", props: {} },
    ]);
    expect(issues.some((i) => i.code === "PROPS_INVALID" && i.componentId === "d")).toBe(true);
  });
});

describe("capability negotiation of overlay parts (fallback)", () => {
  function baseSpec(components: unknown[], events: unknown[] = []): UISpec {
    const parsed: UISpec = {
      kohaku: "0.2",
      intent: { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) },
      dataVersion: "v1",
      state: { open: true },
      components: components as UISpec["components"],
      events: events as UISpec["events"],
      provenance: { tier: "L0", composedBy: "test", cache: "miss" },
    };
    return { ...parsed, components: catalog.validate(parsed.components).normalized };
  }

  it("overlay.dialog unsupported → downgrades to layout.stack and carries over children (body)", () => {
    const spec = baseSpec([
      { id: "root", type: "layout.stack", version: "1.0.0", props: {}, children: ["d"] },
      {
        id: "d",
        type: "overlay.dialog",
        version: "1.0.0",
        props: { title: "Add a note", variant: "default" },
        children: ["form"],
        visibleWhen: { ref: "$state.open", eq: true },
      },
      { id: "form", type: "text.heading", version: "1.0.0", props: { text: "Body" } },
    ]);
    const { spec: out, downgrades } = negotiate(spec, catalog, {
      supports: {
        "layout.stack": "^1.0.0",
        "text.heading": "^1.0.0",
      },
    });
    expect(downgrades).toEqual([
      { id: "d", from: "overlay.dialog", to: "layout.stack", reason: expect.any(String) },
    ]);
    const dialog = out.components.find((c) => c.id === "d")!;
    expect(dialog.type).toBe("layout.stack");
    // The downgrade target is children:optional, so the body remains (inline display with the modal chrome dropped).
    expect(dialog.children).toEqual(["form"]);
    // Pin the downgrade trade-off: title/description are lost (because layout.stack has no title prop
    // and the negotiate mechanism cannot inject a new child node; the result of prioritizing the
    // functional body = children).
    expect(dialog.props["title"]).toBeUndefined();
    expect(dialog.props["description"]).toBeUndefined();
  });

  it("overlay.toast unsupported → downgrades to presentMarkdown terminal and copies message into markdown", () => {
    const spec = baseSpec([
      { id: "root", type: "layout.stack", version: "1.0.0", props: {}, children: ["t"] },
      {
        id: "t",
        type: "overlay.toast",
        version: "1.0.0",
        props: { message: "Saved", tone: "success" },
        visibleWhen: { ref: "$state.open", eq: true },
      },
    ]);
    const { spec: out, downgrades } = negotiate(spec, catalog, {
      supports: {
        "layout.stack": "^1.0.0",
        presentMarkdown: "^1.0.0",
      },
    });
    expect(downgrades).toEqual([
      { id: "t", from: "overlay.toast", to: "presentMarkdown", reason: expect.any(String) },
    ]);
    const toast = out.components.find((c) => c.id === "t")!;
    expect(toast.type).toBe("presentMarkdown");
    expect(toast.props["markdown"]).toBe("Saved");
  });
});
