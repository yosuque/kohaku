import { describe, expect, it } from "vitest";
import {
  asStringArray,
  buildDefaults,
  coerceFieldValues,
  constraintAttrs,
  DEFAULT_MESSAGES,
  type FieldDef,
  mergeRow,
  normalizeOptions,
  validateFormValues,
} from "../../src/index.js";

function field(partial: Partial<FieldDef> & { name: string; type: FieldDef["type"] }): FieldDef {
  return partial as FieldDef;
}

describe("normalizeOptions", () => {
  it("string to {value,label}, object as-is; undefined is an empty array", () => {
    expect(normalizeOptions(["a", { value: "b", label: "B" }])).toEqual([
      { value: "a", label: "a" },
      { value: "b", label: "B" },
    ]);
    expect(normalizeOptions(undefined)).toEqual([]);
  });
});

describe("buildDefaults / mergeRow", () => {
  it("only fields with defaultValue are put into the initial values", () => {
    const fields = [
      field({ name: "x", type: "text", defaultValue: "d" }),
      field({ name: "y", type: "text" }),
    ];
    expect(buildDefaults(fields)).toEqual({ x: "d" });
  });

  it("mergeRow overwrites with row values (row > default; absent columns keep default)", () => {
    const fields = [
      field({ name: "x", type: "text", defaultValue: "d" }),
      field({ name: "y", type: "text" }),
    ];
    const defaults = buildDefaults(fields);
    expect(mergeRow(defaults, fields, { x: "row", y: "ry" })).toEqual({ x: "row", y: "ry" });
    expect(mergeRow(defaults, fields, undefined)).toEqual({ x: "d" });
  });
});

describe("asStringArray", () => {
  it("arrays are stringified, single value is one element, empty/undefined is an empty array", () => {
    expect(asStringArray([1, 2])).toEqual(["1", "2"]);
    expect(asStringArray("a")).toEqual(["a"]);
    expect(asStringArray("")).toEqual([]);
    expect(asStringArray(null)).toEqual([]);
  });
});

describe("coerceFieldValues", () => {
  it("numeric strings become numbers; empty/invalid is null", () => {
    const fields = [field({ name: "n", type: "number" })];
    expect(coerceFieldValues(fields, { n: "12" })).toEqual({ n: 12 });
    expect(coerceFieldValues(fields, { n: "" })).toEqual({ n: null });
    expect(coerceFieldValues(fields, { n: "abc" })).toEqual({ n: null });
  });

  it("multiselect becomes an array, boolean becomes a boolean", () => {
    const fields = [field({ name: "m", type: "multiselect" }), field({ name: "b", type: "boolean" })];
    expect(coerceFieldValues(fields, { m: "one", b: true })).toEqual({ m: ["one"], b: true });
    expect(coerceFieldValues(fields, { m: ["a", "b"], b: "x" })).toEqual({ m: ["a", "b"], b: false });
  });
});

describe("constraintAttrs", () => {
  it("picks up only the validation attributes that are set", () => {
    expect(
      constraintAttrs(field({ name: "n", type: "number", min: 0, max: 10, placeholder: "0-10" })),
    ).toEqual({ min: 0, max: 10, placeholder: "0-10" });
    expect(constraintAttrs(field({ name: "t", type: "text" }))).toEqual({});
  });
});

describe("validateFormValues", () => {
  it("always empty when there are no validation declarations (full backward compatibility)", () => {
    const fields = [
      field({ name: "note", type: "text" }),
      field({ name: "region", type: "select", options: ["a"] }),
    ];
    expect(validateFormValues(fields, { note: "", region: "" }, DEFAULT_MESSAGES)).toEqual([]);
  });

  it("required detects per-type 'empty' (empty string / number null / empty multiselect / boolean not true)", () => {
    const fields = [
      field({ name: "t", type: "text", required: true }),
      field({ name: "n", type: "number", required: true }),
      field({ name: "m", type: "multiselect", required: true, options: ["a"] }),
      field({ name: "b", type: "boolean", required: true }),
    ];
    // assumes coerced values are passed (number as null, multiselect as an array, boolean as a boolean).
    const v = validateFormValues(fields, { t: "", n: null, m: [], b: false }, DEFAULT_MESSAGES);
    expect(v.map((x) => x.field)).toEqual(["t", "n", "m", "b"]);
    expect(v.every((x) => x.rule === "required")).toBe(true);
    // default message (the label falls back to the field name).
    expect(v[0]!.message).toBe("t is required");

    // no violations when satisfied.
    expect(validateFormValues(fields, { t: "x", n: 1, m: ["a"], b: true }, DEFAULT_MESSAGES)).toEqual([]);
  });

  it("optional fields impose no other constraints when blank (an unfilled optional field is valid)", () => {
    const fields = [field({ name: "s", type: "text", minLength: 3, pattern: "[0-9]+" })];
    expect(validateFormValues(fields, { s: "" }, DEFAULT_MESSAGES)).toEqual([]);
  });

  it("applies minLength / maxLength / pattern to strings", () => {
    const min = field({ name: "s", label: "Code", type: "text", minLength: 3 });
    expect(validateFormValues([min], { s: "ab" }, DEFAULT_MESSAGES)[0]).toMatchObject({
      field: "s",
      rule: "minLength",
      message: "Code must be at least 3 characters",
    });
    const max = field({ name: "s", type: "text", maxLength: 2 });
    expect(validateFormValues([max], { s: "abc" }, DEFAULT_MESSAGES)[0]!.rule).toBe("maxLength");
    // pattern is a full match (a partial match does not pass).
    const pat = field({ name: "s", type: "text", pattern: "[0-9]+" });
    expect(validateFormValues([pat], { s: "12a" }, DEFAULT_MESSAGES)[0]!.rule).toBe("pattern");
    expect(validateFormValues([pat], { s: "123" }, DEFAULT_MESSAGES)).toEqual([]);
  });

  it("number's min / max are checked against the numeric range", () => {
    const fields = [field({ name: "score", label: "Score", type: "number", min: 0, max: 10 })];
    expect(validateFormValues(fields, { score: -1 }, DEFAULT_MESSAGES)[0]).toMatchObject({
      rule: "min",
      message: "Score must be 0 or greater",
    });
    expect(validateFormValues(fields, { score: 11 }, DEFAULT_MESSAGES)[0]!.rule).toBe("max");
    expect(validateFormValues(fields, { score: 5 }, DEFAULT_MESSAGES)).toEqual([]);
  });

  it("uses field.message regardless of violation type when present", () => {
    const fields = [
      field({ name: "s", label: "Code", type: "text", required: true, message: "Please enter a code" }),
    ];
    expect(validateFormValues(fields, { s: "" }, DEFAULT_MESSAGES)[0]!.message).toBe("Please enter a code");
  });

  it("returns only the first violation per field (precedence: required → length → pattern)", () => {
    const fields = [field({ name: "s", type: "text", required: true, minLength: 3, pattern: "[0-9]+" })];
    // blank → required has top priority
    expect(validateFormValues(fields, { s: "" }, DEFAULT_MESSAGES)[0]!.rule).toBe("required");
    // present but short → minLength (before pattern)
    expect(validateFormValues(fields, { s: "a" }, DEFAULT_MESSAGES)[0]!.rule).toBe("minLength");
  });

  it("overriding messages changes the wording", () => {
    const fields = [field({ name: "s", label: "Code", type: "text", required: true })];
    const messages = { ...DEFAULT_MESSAGES, formRequired: (l: string) => `${l} is required` };
    expect(validateFormValues(fields, { s: "" }, messages)[0]!.message).toBe("Code is required");
  });
});
