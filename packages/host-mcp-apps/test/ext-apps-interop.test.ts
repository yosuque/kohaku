/**
 * Interoperability check with ext-apps (the official MCP Apps SDK).
 * Since host-mcp-apps does not take ext-apps as a runtime dependency on the server side (meta.ts's local declaration is canonical),
 * this test pins the drift between the local declaration and ext-apps' public types/constants at compile time + the value level.
 * ext-apps is a devDependency (types are erased via import type, and values are read from the server subpath).
 */
import type { McpUiResourceMeta, McpUiToolMeta } from "@modelcontextprotocol/ext-apps";
import {
  RESOURCE_MIME_TYPE as EXT_APPS_MIME_TYPE,
  RESOURCE_URI_META_KEY as EXT_APPS_RESOURCE_URI_KEY,
} from "@modelcontextprotocol/ext-apps/server";
import { describe, expect, it } from "vitest";
import {
  type McpResourceUiMeta,
  type McpToolUiMeta,
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
  resourceUiMeta,
  toolUiMeta,
  UI_META_KEY,
} from "../src/meta.js";

/** Pins at compile time that _B is assignable to A (if it drifts, tsc fails). */
type AssertAssignable<_A, _B extends _A> = true;

// local declaration → ext-apps type (assignability in this direction guarantees "kohaku's _meta is the shape the official SDK expects")
type _ToolMetaFits = AssertAssignable<McpUiToolMeta, McpToolUiMeta>;
// ext-apps type → local declaration (pin the reverse direction too, to detect incompatible value-type changes)
type _ToolMetaCovers = AssertAssignable<McpToolUiMeta, McpUiToolMeta>;
type _ResourceMetaFits = AssertAssignable<McpUiResourceMeta, McpResourceUiMeta>;

// SEP-1865: csp / permissions are the province of the **resource side** and cannot be placed on the tool-side _meta.ui
// (ext-apps rejects it at the type level with `csp?: never`). Pin that this prohibition holds.
// @ts-expect-error — csp cannot be placed on the tool-side _meta.ui (it is the resource side's province)
const invalidToolMeta: McpUiToolMeta = { resourceUri: "ui://x", csp: {} };
void invalidToolMeta;

describe("ext-apps interop", () => {
  it("MIME type and legacy _meta keys match ext-apps' exported constants", () => {
    expect(RESOURCE_MIME_TYPE).toBe(EXT_APPS_MIME_TYPE);
    expect(RESOURCE_URI_META_KEY).toBe(EXT_APPS_RESOURCE_URI_KEY);
  });

  it("toolUiMeta's modern form is valid as ext-apps' McpUiToolMeta", () => {
    const meta = toolUiMeta({ resourceUri: "ui://kohaku/renderer.html", visibility: ["model"] });
    // Pin the value shape (modern + legacy emitted together)
    expect(meta[UI_META_KEY]).toEqual({
      resourceUri: "ui://kohaku/renderer.html",
      visibility: ["model"],
    });
    // Type level: the modern shape is assignable to the ext-apps type (guaranteed by AssertAssignable via McpToolUiMeta)
    const typed: McpUiToolMeta = meta[UI_META_KEY] as McpToolUiMeta;
    expect(typed.resourceUri).toBe("ui://kohaku/renderer.html");
  });

  it("resourceUiMeta declares an empty csp allowlist (no external origins needed) and conforms to the ext-apps type", () => {
    const meta = resourceUiMeta();
    expect(meta).toEqual({
      ui: {
        csp: {
          connectDomains: [],
          resourceDomains: [],
          frameDomains: [],
          baseUriDomains: [],
        },
      },
    });
    // Type level: the resource-side _meta.ui is valid as ext-apps' McpUiResourceMeta
    const typed: McpUiResourceMeta = meta.ui;
    expect(typed.csp?.connectDomains).toEqual([]);
  });
});
