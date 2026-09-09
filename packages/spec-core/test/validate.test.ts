import { describe, expect, it } from "vitest";
import fixture from "../../../spec/examples/quarterly-sales.spec.json";
import { parseSpec, SandboxArtifactRefSchema, safeParseSpec, validateSpecStructure } from "../src/index.js";

function withComponents(components: unknown): Record<string, unknown> {
  return { ...fixture, components, events: [] };
}

describe("structure validation", () => {
  it("detects DUPLICATE_ID", () => {
    const result = safeParseSpec(
      withComponents([
        { id: "root", type: "layout.stack", props: {}, children: [] },
        { id: "root", type: "text.heading", props: {} },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("DUPLICATE_ID");
  });

  it("detects MISSING_ROOT", () => {
    const result = safeParseSpec(withComponents([{ id: "title", type: "text.heading", props: {} }]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("MISSING_ROOT");
  });

  it("detects DANGLING_CHILD", () => {
    const result = safeParseSpec(
      withComponents([{ id: "root", type: "layout.stack", props: {}, children: ["ghost"] }]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("DANGLING_CHILD");
  });

  it("detects CYCLE", () => {
    const result = safeParseSpec(
      withComponents([
        { id: "root", type: "layout.stack", props: {}, children: ["a"] },
        { id: "a", type: "layout.stack", props: {}, children: ["root"] },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("CYCLE");
  });

  it("a Spec whose $ref contains a reserved parameter (leading `_`) is rejected with REF_RESERVED_PARAM (SPEC §2.3 MUST NOT)", () => {
    const result = safeParseSpec(
      withComponents([
        { id: "root", type: "layout.stack", props: {}, children: ["t"] },
        {
          id: "t",
          type: "text.heading",
          props: {},
          data: { $ref: "query://sales/records?_cursor=abc&fy=2026" },
        },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("REF_RESERVED_PARAM");
  });

  it("an unreachable component is an ORPHAN_COMPONENT warning (not an error)", () => {
    const spec = parseSpec(
      withComponents([
        { id: "root", type: "layout.stack", props: {}, children: [] },
        { id: "lonely", type: "text.heading", props: {} },
      ]),
    );
    const issues = validateSpecStructure(spec);
    expect(issues).toEqual([expect.objectContaining({ code: "ORPHAN_COMPONENT", severity: "warning" })]);
  });

  it("two components with an artifact (L2 sandbox node) yield a MULTIPLE_SANDBOX_NODES warning", () => {
    const sha256 = "a".repeat(64);
    const spec = parseSpec(
      withComponents([
        { id: "root", type: "layout.stack", props: {}, children: ["a", "b"] },
        { id: "a", type: "sandbox.html", props: {}, artifact: { inline: "<p>a</p>", sha256 } },
        { id: "b", type: "sandbox.html", props: {}, artifact: { inline: "<p>b</p>", sha256 } },
      ]),
    );
    const issues = validateSpecStructure(spec);
    expect(issues).toEqual([
      expect.objectContaining({ code: "MULTIPLE_SANDBOX_NODES", severity: "warning" }),
    ]);
  });

  it("a single component with an artifact yields no MULTIPLE_SANDBOX_NODES warning", () => {
    const sha256 = "a".repeat(64);
    const spec = parseSpec(
      withComponents([
        { id: "root", type: "layout.stack", props: {}, children: ["a"] },
        { id: "a", type: "sandbox.html", props: {}, artifact: { inline: "<p>a</p>", sha256 } },
      ]),
    );
    const issues = validateSpecStructure(spec);
    expect(issues.map((i) => i.code)).not.toContain("MULTIPLE_SANDBOX_NODES");
  });

  it("detects UNKNOWN_EVENT_TARGET", () => {
    const result = safeParseSpec({
      ...fixture,
      events: [{ on: "ghost.click", emit: "intent.patch", payload: {} }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("UNKNOWN_EVENT_TARGET");
  });

  it("embedding bulk data (data other than $ref) is a schema violation", () => {
    const result = safeParseSpec(
      withComponents([
        {
          id: "root",
          type: "presentChart",
          props: {},
          data: { rows: [{ region: "japan", revenue: 1 }] },
        },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.zodError).toBeDefined();
  });
});

describe("SandboxArtifactRefSchema (strict)", () => {
  const sha256 = "a".repeat(64);

  it("an artifact with only known keys passes", () => {
    expect(SandboxArtifactRefSchema.safeParse({ inline: "<p>x</p>", sha256 }).success).toBe(true);
  });

  it("an unknown key mixed in is rejected rather than stripped", () => {
    // thanks to strict, extra keys other than { inline, uri, sha256 } are not silently dropped but fail validation
    const result = SandboxArtifactRefSchema.safeParse({
      inline: "<p>x</p>",
      sha256,
      rows: [1, 2, 3],
    });
    expect(result.success).toBe(false);
  });
});
