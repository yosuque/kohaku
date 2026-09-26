import { describe, expect, it } from "vitest";
import { buildKohakuCatalogDocument, KOHAKU_SET_STATE_FUNCTION } from "../src/index.js";

describe("buildKohakuCatalogDocument", () => {
  it("declares kohaku.setState with allowedCallers: rendererOnly", () => {
    const doc = buildKohakuCatalogDocument();
    const functions = doc["functions"] as Record<string, unknown>;
    expect(Object.keys(functions)).toEqual([KOHAKU_SET_STATE_FUNCTION]);
    const setState = functions[KOHAKU_SET_STATE_FUNCTION] as Record<string, unknown>;
    expect(setState["allowedCallers"]).toBe("rendererOnly");
    expect(setState["type"]).toBe("object");
    const properties = setState["properties"] as Record<string, unknown>;
    expect(properties["call"]).toEqual({ const: KOHAKU_SET_STATE_FUNCTION });
    const args = properties["args"] as { type: string; properties: Record<string, unknown> };
    expect(args.type).toBe("object");
    expect(args.properties).toHaveProperty("key");
    expect(args.properties).toHaveProperty("value");
  });

  it("defaults to an empty components section", () => {
    const doc = buildKohakuCatalogDocument();
    expect(doc["components"]).toEqual({});
  });

  it("declares a minimal placeholder entry per given componentType", () => {
    const doc = buildKohakuCatalogDocument({ componentTypes: ["presentChart", "presentSpreadsheet"] });
    expect(doc["components"]).toEqual({
      presentChart: { type: "object" },
      presentSpreadsheet: { type: "object" },
    });
  });

  it("never declares callRendererFunction (kohaku has no renderer-side catalog function)", () => {
    const doc = buildKohakuCatalogDocument({ componentTypes: ["presentChart"] });
    expect(JSON.stringify(doc)).not.toContain("callRendererFunction");
  });
});
