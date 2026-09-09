import { parseSpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import fixture from "../../../spec/examples/quarterly-sales.spec.json";
import { CatalogConflictError, coreCatalog, defineComponent, resolveCatalog } from "../src/index.js";

describe("resolveCatalog (federated merge)", () => {
  it("the core catalog resolves and fingerprint is deterministic", () => {
    const a = resolveCatalog(coreCatalog);
    const b = resolveCatalog(coreCatalog);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.list().map((d) => d.type)).toContain("presentChart");
  });

  it("core catalog fingerprint is pinned to 613c927375d8b18a (cross-language golden)", () => {
    // A mismatch means either catalog-content drift (a missed re-run of export-core-catalog) or an
    // implementation difference in fnv1a64 / sorting; it must match the Python golden.
    expect(resolveCatalog(coreCatalog).fingerprint).toBe("613c927375d8b18a");
  });

  it("two contributions with the same type@version but different sandbox-template html yield different fingerprints; identical html yields the same", () => {
    const makePromoted = (html: string) =>
      defineComponent({
        type: "promoted.widget",
        version: "1.0.0",
        description: "promoted widget",
        propsSchema: z.object({ title: z.string().optional() }),
        capabilities: { events: [], data: "required", children: "none" },
        implementation: { kind: "sandbox-template", html },
      });

    const a = resolveCatalog(coreCatalog, { components: [makePromoted("<div>A</div>")] });
    const b = resolveCatalog(coreCatalog, { components: [makePromoted("<div>B</div>")] });
    const aAgain = resolveCatalog(coreCatalog, { components: [makePromoted("<div>A</div>")] });

    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.fingerprint).toBe(aAgain.fingerprint);
  });

  it("presentSpreadsheet has serverSide (default false) at 1.1.0", () => {
    const def = resolveCatalog(coreCatalog).get("presentSpreadsheet")!;
    expect(def.version).toBe("1.1.0");
    // propsSchema fills serverSide with the default false and also accepts true.
    expect((def.propsSchema.parse({}) as { serverSide: boolean }).serverSide).toBe(false);
    expect((def.propsSchema.parse({ serverSide: true }) as { serverSide: boolean }).serverSide).toBe(true);
  });

  it("presentChart has the pointClick event and referenceLines at 1.1.0", () => {
    const def = resolveCatalog(coreCatalog).get("presentChart")!;
    expect(def.version).toBe("1.1.0");
    expect(def.capabilities.events).toContain("pointClick");
    // referenceLines is an (optional) array of { value, label?, axis? }.
    const parsed = def.propsSchema.parse({
      kind: "bar",
      x: "region",
      y: "revenue",
      referenceLines: [{ value: 100, label: "Target" }, { value: 50 }],
    }) as { referenceLines: { value: number; label?: string }[] };
    expect(parsed.referenceLines).toEqual([{ value: 100, label: "Target" }, { value: 50 }]);
  });

  it("adding a new type via a contribution changes the fingerprint", () => {
    const kpi = defineComponent({
      type: "sales.kpiCard",
      version: "1.0.0",
      description: "KPI card",
      propsSchema: z.object({ label: z.string(), format: z.enum(["currency", "percent"]) }),
      capabilities: { events: [], data: "required", children: "none" },
    });
    const merged = resolveCatalog(coreCatalog, { components: [kpi] });
    expect(merged.get("sales.kpiCard")?.version).toBe("1.0.0");
    expect(merged.fingerprint).not.toBe(resolveCatalog(coreCatalog).fingerprint);
  });

  it("overriding an existing type is allowed only on a semver bump", () => {
    const downgrade = defineComponent({
      type: "presentChart",
      version: "0.9.0",
      description: "old chart",
      propsSchema: z.object({ kind: z.string() }),
      capabilities: { events: [], data: "required", children: "none" },
    });
    expect(() => resolveCatalog(coreCatalog, { components: [downgrade] })).toThrow(CatalogConflictError);

    const upgrade = defineComponent({ ...downgrade, version: "2.0.0" });
    expect(resolveCatalog(coreCatalog, { components: [upgrade] }).get("presentChart")?.version).toBe("2.0.0");
  });
});

describe("validate (catalog matching)", () => {
  it("the canonical fixture passes the core catalog and props are filled with defaults", () => {
    const spec = parseSpec(fixture);
    const catalog = resolveCatalog(coreCatalog);
    const { issues, normalized } = catalog.validate(spec.components, spec.events);
    expect(issues).toEqual([]);
    const root = normalized.find((c) => c.id === "root");
    expect(root?.props).toEqual({ direction: "vertical", gap: "md" });
    expect(root?.version).toBe("1.0.0");
  });

  it("detects unknown type / missing data / unsupported event", () => {
    const catalog = resolveCatalog(coreCatalog);
    const { issues } = catalog.validate(
      [
        { id: "root", type: "layout.stack", props: {}, children: ["x", "y"] },
        { id: "x", type: "no.such_type", props: {} },
        { id: "y", type: "presentChart", props: { kind: "bar", x: "a", y: "b" } },
      ],
      [{ on: "y.rowClick", emit: "intent.patch", payload: {} }],
    );
    const codes = issues.map((i) => i.code).sort();
    expect(codes).toEqual(["DATA_REQUIRED", "EVENT_NOT_SUPPORTED", "UNKNOWN_TYPE"]);
  });

  it("presentChart pointClick passes as a declarable event", () => {
    const catalog = resolveCatalog(coreCatalog);
    const { issues } = catalog.validate(
      [
        { id: "root", type: "layout.stack", props: {}, children: ["c1"] },
        {
          id: "c1",
          type: "presentChart",
          props: { kind: "bar", x: "a", y: "b" },
          data: { $ref: "query://x" },
        },
      ],
      [{ on: "c1.pointClick", emit: "intent.patch", payload: { drilldown: "$row.a" } }],
    );
    // pointClick is in capabilities.events, so EVENT_NOT_SUPPORTED is not raised.
    expect(issues.filter((i) => i.code === "EVENT_NOT_SUPPORTED")).toEqual([]);
  });

  it("event.on without a dot is reported as malformed without misleading", () => {
    // Regression: guards against eventName === undefined silently not emitting "undefined". Covers the
    // path where, on the raw events of an L1 draft (before validation), the LLM emits on: "foo".
    const catalog = resolveCatalog(coreCatalog);
    const { issues } = catalog.validate(
      [{ id: "foo", type: "presentForm", props: { fields: [{ name: "a" }], action: "save" } }],
      [{ on: "foo", emit: "action.invoke", payload: {} }],
    );
    const evIssues = issues.filter((i) => i.code === "EVENT_NOT_SUPPORTED");
    expect(evIssues).toHaveLength(1);
    expect(evIssues[0]!.message).not.toContain("undefined");
    expect(evIssues[0]!.message).toContain("componentId.eventName");
  });

  it("a propsSchema that cannot be represented in JSON fails fast at definition time", () => {
    expect(() =>
      defineComponent({
        type: "bad.component",
        version: "1.0.0",
        description: "x",
        propsSchema: z.object({ when: z.date() }),
        capabilities: { events: [], data: "none", children: "none" },
      }),
    ).toThrow(/not JSON-representable/);
  });
});
