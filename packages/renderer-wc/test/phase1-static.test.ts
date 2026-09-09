import type { BindingClient, ResolveOptions } from "@kohaku-ui/data-binding";
import { BindingError } from "@kohaku-ui/data-binding";
import type { TabularData } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { buildSpec, byKohaku, mount, root, tick } from "./util.js";

describe("Phase 1: skeleton + static parts", () => {
  it("layout.stack builds children DFS as a flex column (data-kohaku + textContent)", () => {
    const spec = buildSpec({
      components: [
        { id: "root", type: "layout.stack", props: { gap: "sm" }, children: ["h1", "md1"] },
        { id: "h1", type: "text.heading", props: { text: "Sales", level: 2 } },
        { id: "md1", type: "presentMarkdown", props: { markdown: "This is the body" } },
      ],
    });
    const surface = mount(spec);
    const stack = byKohaku(surface, "root")!;
    expect(stack.tagName).toBe("DIV");
    expect(stack.style.display).toBe("flex");
    expect(stack.style.flexDirection).toBe("column");
    expect(stack.style.gap).toBe("8px");
    // The heading is h2, the body is a markdown div
    const h = byKohaku(surface, "h1")!;
    expect(h.tagName).toBe("H2");
    expect(h.textContent).toBe("Sales");
    expect(byKohaku(surface, "md1")!.textContent).toBe("This is the body");
  });

  it("layout.grid builds grid-template-columns from the columns count", () => {
    const spec = buildSpec({
      components: [
        { id: "root", type: "layout.grid", props: { columns: 3 }, children: ["h1"] },
        { id: "h1", type: "text.heading", props: { text: "A" } },
      ],
    });
    const surface = mount(spec);
    const grid = byKohaku(surface, "root")!;
    expect(grid.style.display).toBe("grid");
    expect(grid.style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");
  });

  it("text.heading clamps level to 1..6 and reflects the color token inline", () => {
    const spec = buildSpec({
      components: [{ id: "root", type: "text.heading", props: { text: "Heading", level: 9 } }],
    });
    const surface = mount(spec, { theme: { "color.text": "#123456" } });
    const h = byKohaku(surface, "root")!;
    expect(h.tagName).toBe("H6");
    expect(h.style.color).toBe("rgb(18, 52, 86)");
    expect(h.style.fontWeight).toBe("650");
  });

  it("presentMarkdown maps headings/lists/code/emphasis into the DOM", () => {
    const md = "# Chapter\n- a\n- b\n\n`code` and **emphasis**\n\n```\nx=1\n```";
    const spec = buildSpec({
      components: [{ id: "root", type: "presentMarkdown", props: { markdown: md } }],
    });
    const surface = mount(spec);
    const container = byKohaku(surface, "root")!;
    expect(container.querySelector("h3")!.textContent).toBe("Chapter");
    expect([...container.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["a", "b"]);
    expect(container.querySelector("code")!.textContent).toBe("code");
    expect(container.querySelector("strong")!.textContent).toBe("emphasis");
    expect(container.querySelector("pre code")!.textContent).toBe("x=1");
  });

  it("ui.loading emits role=status + aria-busy and an aria-hidden spinner SVG", () => {
    const spec = buildSpec({
      components: [{ id: "root", type: "ui.loading", props: { label: "Generating" } }],
    });
    const surface = mount(spec);
    const el = byKohaku(surface, "root")!;
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-busy")).toBe("true");
    expect(el.textContent).toContain("Generating");
    const svg = el.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelector("animateTransform")).not.toBeNull();
  });

  it("unknown type emits a placeholder (role=note) and other siblings survive", () => {
    const spec = buildSpec({
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["x1", "h1"] },
        { id: "x1", type: "totally.unknown", props: {} },
        { id: "h1", type: "text.heading", props: { text: "Survived" } },
      ],
    });
    const surface = mount(spec);
    const notes = root(surface).querySelectorAll('[role="note"]');
    expect(notes.length).toBe(1);
    expect(notes[0]!.textContent).toContain("Unimplemented component type: totally.unknown");
    expect(byKohaku(surface, "h1")!.textContent).toBe("Survived");
  });

  it("presentMetric shows loading before data resolves, then swaps to an aria-labeled KPI when ready", async () => {
    const data: TabularData = {
      columns: [
        { key: "amount", label: "Sales", type: "number" },
        { key: "delta", label: "Change", type: "number" },
      ],
      rows: [{ amount: 1234567, delta: 12000 }],
      dataVersion: "v1",
    };
    const binding: BindingClient = {
      async resolve(_ref, _opts?: ResolveOptions) {
        return data;
      },
      async invokeAction() {
        return { result: null };
      },
    };
    const spec = buildSpec({
      dataVersion: "v1",
      refVersions: { "query://sales/kpi": "v1" },
      components: [
        {
          id: "root",
          type: "presentMetric",
          props: { label: "Total sales", valueColumn: "amount", deltaColumn: "delta", format: "currency" },
          data: { $ref: "query://sales/kpi" },
        },
      ],
    });
    const surface = mount(spec, { binding });
    // The initial synchronous push is loading (role=status)
    expect(root(surface).querySelector('[role="status"]')).not.toBeNull();
    expect(byKohaku(surface, "root")).toBeNull();

    await tick();
    const metric = byKohaku(surface, "root")!;
    expect(metric.getAttribute("aria-label")).toContain("Total sales");
    // The value is locale-formatted (currency). The period-over-period symbol ▲ appears.
    expect(metric.textContent).toContain("▲");
  });

  it("with data but no binding configured, emits a bindingMissing error notice (role=alert)", () => {
    const spec = buildSpec({
      dataVersion: "v1",
      refVersions: { "query://sales/kpi": "v1" },
      components: [
        {
          id: "root",
          type: "presentMetric",
          props: { label: "x", valueColumn: "amount" },
          data: { $ref: "query://sales/kpi" },
        },
      ],
    });
    const surface = mount(spec, {});
    const alert = root(surface).querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("No binding client is configured");
  });

  it("STALE becomes a theme-independent stale notice (binding throws STALE_VERSION)", async () => {
    const binding: BindingClient = {
      async resolve() {
        throw new BindingError("STALE_VERSION", "stale version", { status: 409 });
      },
      async invokeAction() {
        return { result: null };
      },
    };
    const spec = buildSpec({
      dataVersion: "v1",
      refVersions: { "query://sales/kpi": "v1" },
      components: [
        {
          id: "root",
          type: "presentMetric",
          props: { label: "x", valueColumn: "amount" },
          data: { $ref: "query://sales/kpi" },
        },
      ],
    });
    const surface = mount(spec, { binding });
    await tick();
    expect(root(surface).textContent).toContain("Data has been updated");
  });
});
