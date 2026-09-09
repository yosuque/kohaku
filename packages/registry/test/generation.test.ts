import { describe, expect, it } from "vitest";
import {
  buildGenerationSchema,
  coreCatalog,
  presentChart,
  resolveCatalog,
  toGenerationPropsSchema,
  toPropsJsonSchema,
} from "../src/index.js";

const REF = "query://sales/summary?fy=2026&groupBy=region&q=3";

describe("toGenerationPropsSchema (conversion to the provider lowest common denominator)", () => {
  it("optional becomes anyOf with null, all properties required, additionalProperties false", () => {
    const gen = toGenerationPropsSchema(toPropsJsonSchema(presentChart)) as Record<string, any>;
    expect(gen["additionalProperties"]).toBe(false);
    expect((gen["required"] as string[]).sort()).toEqual(Object.keys(gen["properties"] as object).sort());
    // series was originally optional → becomes a union with null
    expect(gen["properties"]["series"]).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    // kind was originally required → left as is
    expect(gen["properties"]["kind"]).toHaveProperty("enum");
    expect(JSON.stringify(gen)).not.toContain('"default"');
  });

  it("presentChart referenceLines (objects inside an array) appear in the generation schema", () => {
    const gen = toGenerationPropsSchema(toPropsJsonSchema(presentChart)) as Record<string, any>;
    // Being optional, it becomes anyOf[array, null]. Each array element is { value(number), label?, axis? }.
    const rl = gen["properties"]["referenceLines"];
    const arraySchema = (rl.anyOf as any[]).find((s) => s.type === "array");
    expect(arraySchema).toBeDefined();
    const item = arraySchema.items;
    expect(item.additionalProperties).toBe(false);
    expect(Object.keys(item.properties as object).sort()).toEqual(["axis", "label", "value"]);
    // value is required (originally required too), so it stays as number.
    expect(item.properties.value).toMatchObject({ type: "number" });
  });
});

describe("buildGenerationSchema", () => {
  const catalog = resolveCatalog(coreCatalog);

  it("data $ref is pinned to the enum of resolved QueryHandles", () => {
    const { jsonSchema } = buildGenerationSchema(catalog, [REF]);
    const text = JSON.stringify(jsonSchema);
    expect(text).toContain(REF);
    // Ensure it does not allow a free $ref outside the enum
    const variants = (jsonSchema as any).properties.components.items.anyOf as any[];
    const chart = variants.find((v) => v.properties.type.const === "presentChart");
    expect(chart.properties.data.properties.$ref.enum).toEqual([REF]);
  });

  it("nested objects inside an array (present-form fields) are also converted recursively", () => {
    // Regression: ensure json-schema.ts's walk descends into the nested objects of array elements
    // (items) and applies "all properties required + optional becomes anyOf[orig,null]",
    // extending coverage beyond presentChart's flat props.
    const { jsonSchema } = buildGenerationSchema(catalog, [REF]);
    const variants = (jsonSchema as any).properties.components.items.anyOf as any[];
    const form = variants.find((v) => v.properties.type.const === "presentForm");
    const item = form.properties.props.properties.fields.items;

    // additionalProperties:false is enforced even for nested objects
    expect(item.additionalProperties).toBe(false);
    // All properties are promoted to required (strict-mode compatible)
    expect((item.required as string[]).sort()).toEqual(Object.keys(item.properties as object).sort());
    // Optional fields become anyOf [orig, null]
    expect(item.properties.label).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    // options is a union of string | {value,label} (backward compatible). The array items are recursively converted into anyOf.
    expect(item.properties.options).toEqual({
      anyOf: [
        {
          type: "array",
          items: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: { value: { type: "string" }, label: { type: "string" } },
                required: ["value", "label"],
                additionalProperties: false,
              },
            ],
          },
        },
        { type: "null" },
      ],
    });
    // The required field (name) stays as is (not nulled)
    expect(item.properties.name).toMatchObject({ type: "string" });
    expect(item.properties.name).not.toHaveProperty("anyOf");
    // For type, which has a default, the default is removed and it stays required with its enum intact (including the new types)
    expect(item.properties.type).toHaveProperty("enum");
    expect(item.properties.type.enum).toEqual(
      expect.arrayContaining(["textarea", "radio", "multiselect", "email", "url"]),
    );
    expect(JSON.stringify(item)).not.toContain('"default"');
  });

  it("presentForm (1.2.0) generation schema conversion does not throw (options union / defaultValue / validation declaration / data optional)", () => {
    // Ensure buildGenerationSchema can still assemble a variant without throwing after the FieldDef
    // extension (i.e. the shape stays representable enough to lower to the ollama structured-output
    // lowest common denominator).
    expect(() => buildGenerationSchema(catalog, [REF])).not.toThrow();
    const { jsonSchema } = buildGenerationSchema(catalog, [REF]);
    const variants = (jsonSchema as any).properties.components.items.anyOf as any[];
    const form = variants.find((v) => v.properties.type.const === "presentForm");
    // Since it became data:"optional", the presentForm variant now shows data($ref enum)
    expect(form.properties.data).toBeDefined();
    expect(JSON.stringify(form)).toContain(REF);
  });

  it("a generation:'excluded' part (ui.loading) does not appear in the variants", () => {
    const { jsonSchema } = buildGenerationSchema(catalog, [REF]);
    const variants = (jsonSchema as any).properties.components.items.anyOf as any[];
    const types = variants.map((v) => v.properties.type.const);
    // Parts in the generation vocabulary exist, but the runtime-only ui.loading cannot be output structurally
    expect(types).toContain("presentChart");
    expect(types).not.toContain("ui.loading");
  });

  it("decode strips nulls and converts payload pairs → object", () => {
    const { decode } = buildGenerationSchema(catalog, [REF]);
    const draft = decode({
      components: [
        {
          id: "root",
          type: "layout.stack",
          props: { direction: "vertical", gap: null },
          children: ["c1"],
        },
        {
          id: "c1",
          type: "presentChart",
          props: { kind: "bar", x: "region", y: "revenue", series: null, stacked: null, title: null },
          children: null,
          data: { $ref: REF },
        },
      ],
      events: [
        {
          on: "c1.rowClick",
          emit: "intent.patch",
          payload: [{ key: "drilldown", value: "$row.region" }],
        },
      ],
    });
    expect(draft.components[1]!.props).toEqual({ kind: "bar", x: "region", y: "revenue" });
    expect(draft.components[0]!.props).toEqual({ direction: "vertical" });
    expect(draft.components[1]!.children).toBeUndefined();
    expect(draft.events[0]!.payload).toEqual({ drilldown: "$row.region" });
  });

  describe("decode defensive validation (a malformed draft throws a descriptive Error)", () => {
    const { decode } = buildGenerationSchema(resolveCatalog(coreCatalog), [REF]);

    it("throws when components is not an array (e.g. 5) (does not TypeError on a bare .map)", () => {
      expect(() => decode({ components: 5, events: [] })).toThrow(/components is not an array/);
    });

    it("throws when components has a null element", () => {
      expect(() => decode({ components: [null], events: [] })).toThrow(/components\[0\] is not an object/);
    });

    it("throws when events has a string element (prevents a downstream on.split TypeError)", () => {
      expect(() =>
        decode({ components: [{ id: "root", type: "layout.stack", props: {} }], events: ["string"] }),
      ).toThrow(/events\[0\] is not an object/);
    });

    it("throws when events[].on is not a string", () => {
      expect(() =>
        decode({
          components: [{ id: "root", type: "layout.stack", props: {} }],
          events: [{ on: 42, emit: "intent.patch", payload: [] }],
        }),
      ).toThrow(/events\[0\].on is not a string/);
    });

    it("an out-of-enum emit is a string so decode passes it (delegates to collectIssues Zod validation)", () => {
      // enum validation is not decode's responsibility. If it is a string, it passes here and the downstream EventBinding Zod rejects it.
      const draft = decode({
        components: [{ id: "root", type: "layout.stack", props: {} }],
        events: [{ on: "root.click", emit: "intent.nope", payload: [] }],
      });
      expect(draft.events[0]!.emit).toBe("intent.nope");
    });
  });
});

describe("validate: a non-string on becomes an issue instead of a TypeError (defensive event.on validation)", () => {
  const catalog = resolveCatalog(coreCatalog);

  it("reports EVENT_NOT_SUPPORTED without failing on split even when event.on is not a string", () => {
    const { issues } = catalog.validate(
      [{ id: "root", type: "layout.stack", props: {} }],
      // Pass a non-string on via a type cast (defense for the path where a malformed draft bypasses decode and arrives)
      [{ on: 123 as unknown as string, emit: "intent.patch", payload: {} }],
    );
    expect(issues.some((i) => i.code === "EVENT_NOT_SUPPORTED")).toBe(true);
  });
});
