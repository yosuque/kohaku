/**
 * Pins that `bootMcpRenderer`'s `disclosure` option reaches SpecView (design.md #66). The mounted tree is
 * server-rendered (no DOM needed) with SpecView replaced by a probe that records the `disclosure` prop it
 * receives -- SpecView's own disclosure output is covered in renderer-react.
 */
import { createBindingClient } from "@kohaku-ui/data-binding";
import { createCoreRegistry } from "@kohaku-ui/renderer-react/core";
import { parseSpec } from "@kohaku-ui/spec-core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const received = vi.hoisted(() => [] as (string | undefined)[]);

vi.mock("@kohaku-ui/renderer-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kohaku-ui/renderer-react")>();
  return {
    ...actual,
    SpecView: (props: { disclosure?: string }) => {
      received.push(props.disclosure);
      return null;
    },
  };
});

const { Root } = await import("../src/boot/main.js");

const SPEC = parseSpec({
  kohaku: "0.1",
  intent: { canonical: "sales.trend", params: {}, hash: `sha256:${"ab".repeat(32)}` },
  dataVersion: "sales@seed-1",
  components: [{ id: "root", type: "text.heading", props: { level: 2, text: "Heading" } }],
  events: [],
  provenance: { tier: "L1", composedBy: "test", cache: "miss" },
});

type RootProps = Parameters<typeof Root>[0];

function render(disclosure: RootProps["disclosure"]): void {
  const controller: RootProps["controller"] = {
    makeBinding: () =>
      createBindingClient({
        capability: "cap",
        fetcher: async () => ({ status: 404, body: null }),
        actionFetcher: async () => {
          throw new Error("no writes in this test");
        },
      }),
    handleEvent: () => {},
  };
  renderToStaticMarkup(
    createElement(Root, {
      controller,
      initialView: { spec: SPEC, capability: "cap" },
      impls: createCoreRegistry(),
      ...(disclosure != null ? { disclosure } : {}),
    }),
  );
}

describe("bootMcpRenderer disclosure option", () => {
  beforeEach(() => {
    received.length = 0;
  });

  it('defaults to "off" (the DOM stays identical to a renderer without disclosure)', () => {
    render(undefined);
    expect(received).toEqual(["off"]);
  });

  it.each(["attributes", "label"] as const)("passes %s through to SpecView", (mode) => {
    render(mode);
    expect(received).toEqual([mode]);
  });
});
