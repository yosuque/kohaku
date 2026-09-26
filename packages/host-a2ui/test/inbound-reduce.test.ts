import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  A2UI_ROOT_COMPONENT_ID,
  A2uiIngestError,
  getAtPointer,
  getRootComponent,
  type InboundA2uiMessage,
  parseInboundA2uiMessage,
  reduceSurfaceMessage,
  reduceSurfaces,
  type SurfaceState,
} from "../src/index.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "inbound");

/** Loads a hand-written *.jsonl fixture (one compact-JSON A2UI message per line) and schema-validates every line. */
function loadFixture(name: string): InboundA2uiMessage[] {
  const text = readFileSync(join(FIXTURES_DIR, name), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => parseInboundA2uiMessage(JSON.parse(line)));
}

/** Folds a sequence of messages onto an empty surface registry, returning the final state map. */
function fold(messages: InboundA2uiMessage[]): Map<string, SurfaceState> {
  return messages.reduce(reduceSurfaces, new Map<string, SurfaceState>());
}

describe("inbound schemas: fixtures parse and schema-validate", () => {
  it("v091-basic.jsonl: 3 valid v0.9.1 messages", () => {
    const messages = loadFixture("v091-basic.jsonl");
    expect(messages).toHaveLength(3);
    expect(messages.every((m) => m.version === "v0.9.1")).toBe(true);
  });

  it("v1-bundled.jsonl: 3 valid v1.0 messages, the first bundling components + dataModel", () => {
    const messages = loadFixture("v1-bundled.jsonl");
    expect(messages).toHaveLength(3);
    expect(messages.every((m) => m.version === "v1.0")).toBe(true);
    expect(messages[0]).toHaveProperty("createSurface");
  });

  it("v1-split-catalog.jsonl: a v1.0 createSurface with no default catalogId, per-component catalogId instead", () => {
    const messages = loadFixture("v1-split-catalog.jsonl");
    expect(messages).toHaveLength(1);
    const createSurface = (messages[0] as { createSurface: { catalogId?: string } }).createSurface;
    expect(createSurface.catalogId).toBeUndefined();
  });
});

describe("inbound schemas: strict rejection", () => {
  it("rejects an unknown top-level key on the envelope", () => {
    expect(() =>
      parseInboundA2uiMessage({
        version: "v0.9.1",
        createSurface: { surfaceId: "s", catalogId: "c" },
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects an unknown version literal", () => {
    expect(() =>
      parseInboundA2uiMessage({ version: "v2.0", createSurface: { surfaceId: "s", catalogId: "c" } }),
    ).toThrow();
  });

  it("rejects updateDataModel with no value under v1.0 (value is required)", () => {
    expect(() =>
      parseInboundA2uiMessage({ version: "v1.0", updateDataModel: { surfaceId: "s", path: "/x" } }),
    ).toThrow();
  });

  it("accepts updateDataModel with no value under v0.9.1 (delete-by-omission)", () => {
    expect(() =>
      parseInboundA2uiMessage({ version: "v0.9.1", updateDataModel: { surfaceId: "s", path: "/x" } }),
    ).not.toThrow();
  });

  it("rejects a component with an unknown structural key shape (e.g. children as a number)", () => {
    expect(() =>
      parseInboundA2uiMessage({
        version: "v0.9.1",
        updateComponents: { surfaceId: "s", components: [{ id: "root", component: "Column", children: 1 }] },
      }),
    ).toThrow();
  });

  it("still accepts arbitrary catalog-inlined props on a component (open index signature)", () => {
    expect(() =>
      parseInboundA2uiMessage({
        version: "v0.9.1",
        updateComponents: {
          surfaceId: "s",
          components: [{ id: "t", component: "Text", text: "hi", weight: "bold", size: 3 }],
        },
      }),
    ).not.toThrow();
  });

  it("rejects createSurface (v1.0) components: [] (minItems: 1)", () => {
    expect(() =>
      parseInboundA2uiMessage({ version: "v1.0", createSurface: { surfaceId: "s", components: [] } }),
    ).toThrow();
  });
});

describe("reduceSurfaceMessage / reduceSurfaces: folding into SurfaceState", () => {
  it("v091-basic.jsonl folds into one surface with the root+3 components and the data model set", () => {
    const surfaces = fold(loadFixture("v091-basic.jsonl"));
    expect(surfaces.size).toBe(1);
    const surface = surfaces.get("srf-1")!;
    expect(Object.keys(surface.components).sort()).toEqual(["btn", "btn_label", "hdr", "root"]);
    expect(surface.dataModel).toEqual({ greeting: "hi" });
    expect(getRootComponent(surface).component).toBe("Column");
  });

  it("v1-bundled.jsonl: createSurface bundles components+dataModel, later messages upsert/patch them", () => {
    const surfaces = fold(loadFixture("v1-bundled.jsonl"));
    const surface = surfaces.get("srf-2")!;
    expect(Object.keys(surface.components).sort()).toEqual(["root", "title"]);
    expect(surface.components["title"]!["text"]).toBe("Bundled surface (updated)");
    expect(surface.dataModel).toEqual({ count: 1 });
  });

  it("createSurface twice for the same surfaceId throws (fixed after creation)", () => {
    const messages = loadFixture("v091-basic.jsonl");
    expect(() => fold([messages[0]!, messages[0]!])).toThrow(A2uiIngestError);
  });

  it("updateComponents / updateDataModel before createSurface throws", () => {
    const messages = loadFixture("v091-basic.jsonl");
    expect(() => reduceSurfaceMessage(undefined, messages[1]!)).toThrow(A2uiIngestError);
    expect(() => reduceSurfaceMessage(undefined, messages[2]!)).toThrow(A2uiIngestError);
  });

  it("duplicate id within one components array throws", () => {
    const message = parseInboundA2uiMessage({
      version: "v0.9.1",
      createSurface: { surfaceId: "s", catalogId: "c" },
    });
    const created = reduceSurfaceMessage(undefined, message);
    const dupe = parseInboundA2uiMessage({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "s",
        components: [
          { id: "root", component: "Column" },
          { id: "root", component: "Row" },
        ],
      },
    });
    expect(() => reduceSurfaceMessage(created, dupe)).toThrow(A2uiIngestError);
  });

  it("getRootComponent throws when the surface has no root yet", () => {
    const message = parseInboundA2uiMessage({
      version: "v0.9.1",
      createSurface: { surfaceId: "s", catalogId: "c" },
    });
    const created = reduceSurfaceMessage(undefined, message)!;
    expect(() => getRootComponent(created)).toThrow(A2uiIngestError);
    expect(A2UI_ROOT_COMPONENT_ID).toBe("root");
  });

  it("updateDataModel path defaults to '/' (whole data model) and creates missing intermediate objects", () => {
    let state: SurfaceState | undefined = reduceSurfaceMessage(
      undefined,
      parseInboundA2uiMessage({ version: "v0.9.1", createSurface: { surfaceId: "s", catalogId: "c" } }),
    );
    state = reduceSurfaceMessage(
      state,
      parseInboundA2uiMessage({
        version: "v0.9.1",
        updateDataModel: { surfaceId: "s", path: "/a/b", value: 1 },
      }),
    );
    expect(state!.dataModel).toEqual({ a: { b: 1 } });

    state = reduceSurfaceMessage(
      state,
      parseInboundA2uiMessage({
        version: "v0.9.1",
        updateDataModel: { surfaceId: "s", value: { fresh: true } },
      }),
    );
    expect(state!.dataModel).toEqual({ fresh: true });
  });

  it("updateDataModel with no value (v0.9.1) deletes the key at path; a missing path is a no-op", () => {
    let state: SurfaceState | undefined = reduceSurfaceMessage(
      undefined,
      parseInboundA2uiMessage({ version: "v0.9.1", createSurface: { surfaceId: "s", catalogId: "c" } }),
    );
    state = reduceSurfaceMessage(
      state,
      parseInboundA2uiMessage({
        version: "v0.9.1",
        updateDataModel: { surfaceId: "s", path: "/a", value: 1 },
      }),
    );
    state = reduceSurfaceMessage(
      state,
      parseInboundA2uiMessage({ version: "v0.9.1", updateDataModel: { surfaceId: "s", path: "/a" } }),
    );
    expect(state!.dataModel).toEqual({});
    // Deleting an already-absent path is a no-op, not an error.
    state = reduceSurfaceMessage(
      state,
      parseInboundA2uiMessage({ version: "v0.9.1", updateDataModel: { surfaceId: "s", path: "/gone/deep" } }),
    );
    expect(state!.dataModel).toEqual({});
  });

  it("deleteSurface removes the surface; deleting an unknown surface is a fail-open no-op", () => {
    const surfaces = fold(loadFixture("v091-basic.jsonl"));
    const deleted = reduceSurfaces(
      surfaces,
      parseInboundA2uiMessage({ version: "v0.9.1", deleteSurface: { surfaceId: "srf-1" } }),
    );
    expect(deleted.has("srf-1")).toBe(false);

    const noop = reduceSurfaces(
      deleted,
      parseInboundA2uiMessage({ version: "v0.9.1", deleteSurface: { surfaceId: "does-not-exist" } }),
    );
    expect(noop.size).toBe(0);
  });
});

describe("security: prototype-pollution-shaped JSON Pointer / component id input is rejected, never mistaken for own data", () => {
  it("rejects updateDataModel({path: '/__proto__/polluted', value: ...}) outright", () => {
    const state = reduceSurfaceMessage(
      undefined,
      parseInboundA2uiMessage({ version: "v0.9.1", createSurface: { surfaceId: "s", catalogId: "c" } }),
    );
    expect(() =>
      reduceSurfaceMessage(
        state,
        parseInboundA2uiMessage({
          version: "v0.9.1",
          updateDataModel: { surfaceId: "s", path: "/__proto__/polluted", value: "yes" },
        }),
      ),
    ).toThrow(A2uiIngestError);
  });

  it("rejects 'constructor' and 'prototype' pointer tokens too", () => {
    const state = reduceSurfaceMessage(
      undefined,
      parseInboundA2uiMessage({ version: "v0.9.1", createSurface: { surfaceId: "s", catalogId: "c" } }),
    );
    for (const reserved of ["constructor", "prototype"]) {
      expect(() =>
        reduceSurfaceMessage(
          state,
          parseInboundA2uiMessage({
            version: "v0.9.1",
            updateDataModel: { surfaceId: "s", path: `/${reserved}/x`, value: "yes" },
          }),
        ),
      ).toThrow(A2uiIngestError);
    }
  });

  it("getAtPointer never returns an inherited value for a path that was never actually set", () => {
    const dataModel = { greeting: "hi" };
    // None of these are own properties of `dataModel`, even though they exist on Object.prototype.
    expect(getAtPointer(dataModel, "/toString")).toBeUndefined();
    expect(getAtPointer(dataModel, "/hasOwnProperty")).toBeUndefined();
    expect(getAtPointer(dataModel, "/valueOf")).toBeUndefined();
  });

  it("rejects a component id of '__proto__' / 'constructor' / 'prototype' at the schema layer", () => {
    for (const reserved of ["__proto__", "constructor", "prototype"]) {
      // Parsed from a JSON string (like a real wire message would be) rather than an object literal, so
      // "id" is an ordinary own string property with the value "__proto__" — the schema's refine check is
      // what is actually being exercised here, not JS's own bracket-assignment quirks.
      const raw: unknown = JSON.parse(
        JSON.stringify({
          version: "v0.9.1",
          updateComponents: { surfaceId: "s", components: [{ id: reserved, component: "Text", text: "x" }] },
        }),
      );
      expect(() => parseInboundA2uiMessage(raw)).toThrow();
    }
  });

  it("upsertComponents (reduceSurfaceMessage) independently rejects a reserved id even if schema validation were bypassed", () => {
    const state = reduceSurfaceMessage(
      undefined,
      parseInboundA2uiMessage({ version: "v0.9.1", createSurface: { surfaceId: "s", catalogId: "c" } }),
    );
    // Bypasses parseInboundA2uiMessage's schema check on purpose, to prove reduceSurfaceMessage's own
    // defense (RESERVED_OBJECT_KEYS check in upsertComponents) is independent of the schema layer.
    const smuggled = {
      version: "v0.9.1" as const,
      updateComponents: {
        surfaceId: "s",
        components: [{ id: "constructor", component: "Text" }],
      },
    };
    expect(() => reduceSurfaceMessage(state, smuggled)).toThrow(A2uiIngestError);
  });
});
