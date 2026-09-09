import type { ComponentNode } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { resolveRowProps, substituteRow } from "../src/index.js";

describe("substituteRow", () => {
  it('substitutes "$row.<key>" deep inside nested objects and arrays', () => {
    const out = substituteRow(
      { title: "$row.name", nested: { v: "$row.value" }, list: ["$row.id", "lit"] },
      { name: "Taro", value: 10, id: 1 },
    );
    expect(out).toEqual({ title: "Taro", nested: { v: 10 }, list: [1, "lit"] });
  });

  it("missing key is null; non-string and non-$row. strings pass through", () => {
    expect(substituteRow("$row.missing", {})).toBeNull();
    expect(substituteRow("plain", {})).toBe("plain");
    expect(substituteRow(42, {})).toBe(42);
  });
});

describe("resolveRowProps", () => {
  it("returns a new node with only props substituted (visibleWhen / data untouched)", () => {
    const node = {
      id: "cell",
      type: "text.heading",
      props: { text: "$row.name" },
      visibleWhen: { "$state.x": true },
      data: { $ref: "query://a/b?c=$row.x" },
    } as unknown as ComponentNode;
    const out = resolveRowProps(node, { name: "Hanako" });
    expect(out.props).toEqual({ text: "Hanako" });
    // the original node is unchanged
    expect(node.props["text"]).toBe("$row.name");
    // everything other than props is copied but not substituted
    expect((out as unknown as { visibleWhen: unknown }).visibleWhen).toEqual({ "$state.x": true });
    expect(out.data).toEqual({ $ref: "query://a/b?c=$row.x" });
  });
});
