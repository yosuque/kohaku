import type { OperationDescriptor, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { buildActionManifest } from "../src/action-manifest.js";
import type { OperationIndexEntry } from "../src/operation-index.js";

function indexOf(...descriptors: OperationDescriptor[]): ReadonlyMap<string, OperationIndexEntry> {
  const map = new Map<string, OperationIndexEntry>();
  for (const descriptor of descriptors) {
    map.set(descriptor.name, { descriptor, paramsSchema: descriptor.paramsSchema as never });
  }
  return map;
}

function specWithActions(...actions: string[]): UISpec {
  return {
    kohaku: "0.2",
    intent: { canonical: "sales.trend", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "v1",
    components: [{ id: "root", type: "layout.stack", props: {}, children: [] }],
    events: actions.map((action, i) => ({
      on: `root.event${i}`,
      emit: "action.invoke" as const,
      payload: { action },
    })),
    provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
  };
}

describe("buildActionManifest", () => {
  it("returns undefined when the Spec declares no write actions", () => {
    const spec = specWithActions();
    expect(buildActionManifest(spec, indexOf())).toBeUndefined();
  });

  it("builds one entry per declared write action that is a real DomainPort operation", () => {
    const spec = specWithActions("annotate", "publish");
    const index = indexOf(
      {
        name: "annotate",
        description: "d",
        tier: "confirm",
        confirmMessage: "Are you sure?",
        paramsSchema: { type: "object", properties: { note: { type: "string" } } },
      },
      { name: "publish", description: "d" },
    );
    const manifest = buildActionManifest(spec, index);
    expect(manifest).toEqual({
      annotate: {
        tier: "confirm",
        confirmMessage: "Are you sure?",
        paramsSchema: { type: "object", properties: { note: { type: "string" } } },
      },
      publish: { tier: "auto" },
    });
  });

  it("silently omits a declared action that is not a real DomainPort operation", () => {
    const spec = specWithActions("annotate", "hallucinated");
    const index = indexOf({ name: "annotate", description: "d" });
    const manifest = buildActionManifest(spec, index);
    expect(manifest).toEqual({ annotate: { tier: "auto" } });
  });

  it("returns undefined (not {}) when every declared action was dropped", () => {
    const spec = specWithActions("hallucinated");
    const manifest = buildActionManifest(spec, indexOf());
    expect(manifest).toBeUndefined();
  });

  it("defaults tier to 'auto' when the descriptor omits it", () => {
    const spec = specWithActions("annotate");
    const index = indexOf({ name: "annotate", description: "d" });
    expect(buildActionManifest(spec, index)).toEqual({ annotate: { tier: "auto" } });
  });
});
