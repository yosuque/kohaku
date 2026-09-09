import { describe, expect, it, vi } from "vitest";
import type { UISpec } from "../src/index.js";
import { collectCapabilityScopes } from "../src/index.js";

const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L0", composedBy: "test", cache: "hit" } as const;

/** A bound-data component whose bind has `paramCount` params, each with `valueCount` distinct values
 * (so the Cartesian product is exactly paramCount ** valueCount... actually valueCount ** paramCount). */
function manyBindVariantsSpec(paramCount: number, valueCount: number): UISpec {
  const bind: Record<string, { $state: string; values: string[] }> = {};
  for (let p = 0; p < paramCount; p++) {
    bind[`p${p}`] = {
      $state: `s${p}`,
      values: Array.from({ length: valueCount }, (_, i) => `v${p}_${i}`),
    };
  }
  return {
    kohaku: "0.2",
    intent: INTENT,
    dataVersion: "v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["kpi"] },
      {
        id: "kpi",
        type: "presentMetric",
        props: { label: "Sales", valueColumn: "revenue" },
        data: { $ref: "query://sales/summary?fy=2026", bind },
      },
    ],
    events: [],
    provenance: PROVENANCE,
  };
}

describe("collectCapabilityScopes", () => {
  it("issues a read scope per enumerated bind variant plus write scopes for action.invoke events", () => {
    const spec: UISpec = {
      kohaku: "0.2",
      intent: INTENT,
      dataVersion: "v1",
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["kpi", "btn"] },
        {
          id: "kpi",
          type: "presentMetric",
          props: { label: "Sales", valueColumn: "revenue" },
          data: {
            $ref: "query://sales/summary?fy=2026&region=japan",
            bind: { region: { $state: "region", values: ["japan", "europe"] } },
          },
        },
        { id: "btn", type: "action.button", props: { label: "Save" } },
      ],
      events: [{ on: "btn.click", emit: "action.invoke", payload: { action: "save" } }],
      provenance: PROVENANCE,
    };
    const scopes = collectCapabilityScopes(spec);
    expect(scopes.filter((s) => s.kind === "read")).toHaveLength(2);
    expect(scopes.some((s) => s.kind === "write" && s.ref === "save")).toBe(true);
  });

  it("over the limit throws before enumeration (4 bind params x 20 values each)", async () => {
    const spec = manyBindVariantsSpec(4, 20); // 20**4 = 160,000, far over MAX_BIND_VARIANTS (256)

    const bindModule = await import("../src/bind.js");
    const enumerateSpy = vi.spyOn(bindModule, "enumerateBindVariants");
    try {
      expect(() => collectCapabilityScopes(spec)).toThrow(/total bind variants 160000 exceed the limit 256/);
      // The pre-check (product-based upper bound) rejects before real enumeration ever runs — proven by
      // enumerateBindVariants never being called, not merely by a matching error message.
      expect(enumerateSpy).not.toHaveBeenCalled();
    } finally {
      enumerateSpy.mockRestore();
    }
  });

  it("stays under the limit and enumerates normally just below the boundary", () => {
    // 2 params x 16 values = 256, exactly at MAX_BIND_VARIANTS — must not throw.
    const spec = manyBindVariantsSpec(2, 16);
    expect(() => collectCapabilityScopes(spec)).not.toThrow();
    expect(collectCapabilityScopes(spec).filter((s) => s.kind === "read")).toHaveLength(256);
  });
});
