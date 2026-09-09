import { describe, expect, it } from "vitest";
import fixture from "../../../spec/examples/quarterly-sales.spec.json";
import { applyPatch, diffSpec, orderComponents, parseSpec, type UISpec } from "../src/index.js";

const base = (): UISpec => parseSpec(fixture);

describe("diffSpec / applyPatch", () => {
  it("the diff of identical Specs is a near-empty patch", () => {
    const a = base();
    const patch = diffSpec(a, a);
    expect(patch).toEqual({ baseIntentHash: a.intent.hash });
  });

  it("detects props change → upsert / component removal → remove, and applying restores the original", () => {
    const prev = base();
    const next: UISpec = {
      ...prev,
      dataVersion: "ledger@2026-06-11T00:00:00Z",
      components: prev.components
        .filter((c) => c.id !== "table1")
        .map((c) =>
          c.id === "root"
            ? { ...c, children: ["title", "chart1"] }
            : c.id === "title"
              ? { ...c, props: { ...c.props, text: "Updated title" } }
              : c,
        ),
      events: [],
    };

    const patch = diffSpec(prev, next);
    expect(patch.remove).toEqual(["table1"]);
    expect(patch.upsert?.map((c) => c.id).sort()).toEqual(["root", "title"]);
    expect(patch.dataVersion).toBe(next.dataVersion);
    expect(patch.events).toEqual([]);

    const applied = applyPatch(prev, patch);
    expect(applied).toEqual(next);
  });

  it("refVersions changes appear in the patch and round-trip via applyPatch", () => {
    const prev: UISpec = {
      ...base(),
      refVersions: { "query://a": "v1", "query://b": "v1" },
    };
    const next: UISpec = {
      ...prev,
      refVersions: { "query://a": "v2", "query://b": "v1" },
    };
    const patch = diffSpec(prev, next);
    expect(patch.refVersions).toEqual({ "query://a": "v2", "query://b": "v1" });
    expect(applyPatch(prev, patch)).toEqual(next);
  });

  it("refVersions is not included in the patch when unchanged", () => {
    const a: UISpec = { ...base(), refVersions: { "query://a": "v1" } };
    const patch = diffSpec(a, a);
    expect(patch).toEqual({ baseIntentHash: a.intent.hash });
    expect(applyPatch(a, patch)).toEqual(a);
  });

  it("refVersions deletion is expressed as null and disappears via applyPatch", () => {
    const prev: UISpec = { ...base(), refVersions: { "query://a": "v1" } };
    const next = base(); // has no refVersions
    const patch = diffSpec(prev, next);
    expect(patch.refVersions).toBeNull();
    const applied = applyPatch(prev, patch);
    expect(applied.refVersions).toBeUndefined();
    expect(applied).toEqual(next);
  });

  it("0.1 -> 0.2 round-trip (with state): the version change is captured in the patch and restored by applyPatch", () => {
    const prev: UISpec = { ...base(), kohaku: "0.1" };
    const next: UISpec = { ...prev, kohaku: "0.2", state: { region: "japan" } };
    const patch = diffSpec(prev, next);
    expect(patch.kohaku).toBe("0.2");
    expect(patch.state).toEqual({ region: "japan" });
    // Without patch.kohaku, applying against prev would keep kohaku "0.1" while adding `state`, which
    // validateSpecStructure's feature gate rejects as VERSION_FEATURE_MISMATCH.
    expect(applyPatch(prev, patch)).toEqual(next);
  });

  it("0.2 -> 0.1 round-trip: the version downgrade is captured in the patch and restored by applyPatch", () => {
    const prev: UISpec = { ...base(), kohaku: "0.2" };
    const next: UISpec = { ...base(), kohaku: "0.1" };
    const patch = diffSpec(prev, next);
    expect(patch.kohaku).toBe("0.1");
    expect(applyPatch(prev, patch)).toEqual(next);
  });

  it("kohaku is omitted from the patch when unchanged", () => {
    const a = base();
    const patch = diffSpec(a, a);
    expect("kohaku" in patch).toBe(false);
  });

  it("baseIntentHash mismatch is PATCH_BASE_MISMATCH", () => {
    const prev = base();
    expect(() => applyPatch(prev, { baseIntentHash: "sha256:" + "0".repeat(64) })).toThrowError(
      /PATCH_BASE_MISMATCH|targets intent/,
    );
  });

  it("a patch that breaks the structure is rejected on application", () => {
    const prev = base();
    expect(() => applyPatch(prev, { baseIntentHash: prev.intent.hash, remove: ["root"] })).toThrow(
      /structurally invalid/,
    );
  });
});

describe("orderComponents (canonical order)", () => {
  it("orders by DFS from root, with unreachable components sorted by id at the tail", () => {
    const prev = base();
    const shuffled = [...prev.components].reverse();
    const ordered = orderComponents(shuffled);
    expect(ordered.map((c) => c.id)).toEqual(["root", "title", "chart1", "table1"]);
  });
});
