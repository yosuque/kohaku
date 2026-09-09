import { describe, expect, it } from "vitest";
import { parseMarkdownBlocks, parseMarkdownInline } from "../../src/index.js";

describe("parseMarkdownInline", () => {
  it("splits `code` and **bold** (keeps empty segments too)", () => {
    expect(parseMarkdownInline("a `code` b **bold**")).toEqual([
      { type: "text", text: "a " },
      { type: "code", text: "code" },
      { type: "text", text: " b " },
      { type: "strong", text: "bold" },
      { type: "text", text: "" },
    ]);
  });

  it("a single text when there is no markup", () => {
    expect(parseMarkdownInline("plain")).toEqual([{ type: "text", text: "plain" }]);
  });
});

describe("parseMarkdownBlocks", () => {
  it("heading has a resolved level of # count + 2 (max 6)", () => {
    expect(parseMarkdownBlocks("# Title")).toEqual([
      { type: "heading", level: 3, inline: [{ type: "text", text: "Title" }] },
    ]);
    expect(parseMarkdownBlocks("#### Deep")[0]).toMatchObject({ type: "heading", level: 6 });
  });

  it("groups consecutive '- ' lines into one list", () => {
    expect(parseMarkdownBlocks("- a\n- b")).toEqual([
      {
        type: "list",
        items: [[{ type: "text", text: "a" }], [{ type: "text", text: "b" }]],
      },
    ]);
  });

  it("turns a ``` fence into a code block", () => {
    expect(parseMarkdownBlocks("```\nline1\nline2\n```")).toEqual([{ type: "code", code: "line1\nline2" }]);
  });

  it("paragraphs starting with '>' are muted, normal paragraphs are non-muted; blank lines are ignored", () => {
    expect(parseMarkdownBlocks("> quote\n\nplain")).toEqual([
      { type: "paragraph", muted: true, inline: [{ type: "text", text: "quote" }] },
      { type: "paragraph", muted: false, inline: [{ type: "text", text: "plain" }] },
    ]);
  });
});
