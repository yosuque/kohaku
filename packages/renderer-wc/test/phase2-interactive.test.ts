import type { ActionResult, BindingClient, ResolveOptions } from "@kohaku-ui/data-binding";
import type { TabularData } from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import type { SurfaceEvent } from "../src/index.js";
import { KOHAKU_EVENT } from "../src/index.js";
import { buildSpec, byKohaku, mount, root, tick } from "./util.js";

function tableData(rows: Record<string, unknown>[], extra: Partial<TabularData> = {}): TabularData {
  return {
    columns: [
      { key: "region", label: "Region", type: "string" },
      { key: "amount", label: "Sales", type: "number" },
    ],
    rows: rows as TabularData["rows"],
    dataVersion: "v1",
    ...extra,
  };
}

describe("Phase 2: layout.tabs", () => {
  it("state-driven: builds only the selected panel, aria-selected and arrow-key navigation work", () => {
    const spec = buildSpec({
      state: { tab: "a" },
      components: [
        { id: "root", type: "layout.tabs", props: { stateKey: "tab" }, children: ["ta", "tb"] },
        { id: "ta", type: "layout.tab", props: { value: "a", label: "Side A" }, children: ["ha"] },
        { id: "tb", type: "layout.tab", props: { value: "b", label: "Side B" }, children: ["hb"] },
        { id: "ha", type: "text.heading", props: { text: "Panel A" } },
        { id: "hb", type: "text.heading", props: { text: "Panel B" } },
      ],
    });
    const surface = mount(spec);
    const tabsEl = byKohaku(surface, "root")!;
    const buttons = [...tabsEl.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
    expect(buttons.map((b) => b.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    // Only the selected panel is built (B is not built)
    expect(byKohaku(surface, "ha")).not.toBeNull();
    expect(byKohaku(surface, "hb")).toBeNull();

    // ArrowRight moves to tab B → panel swap
    buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const buttons2 = [...tabsEl.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
    expect(buttons2.map((b) => b.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(byKohaku(surface, "ha")).toBeNull();
    expect(byKohaku(surface, "hb")!.textContent).toBe("Panel B");
  });
});

describe("Phase 2: control.select and A1 cross-filter", () => {
  it("change → state.set → data.bind part's effective ref re-resolves (does not fire compose)", async () => {
    const resolved: string[] = [];
    const binding: BindingClient = {
      async resolve(ref) {
        const s = typeof ref === "string" ? ref : ref.$ref;
        resolved.push(s);
        return tableData([{ region: "japan", amount: 100 }]);
      },
      async invokeAction() {
        return { result: null };
      },
    };
    const REF = "query://sales/records?region=japan";
    const spec = buildSpec({
      state: { region: "japan" },
      dataVersion: "v1",
      refVersions: { [REF]: "v1" },
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["sel", "tbl"] },
        {
          id: "sel",
          type: "control.select",
          props: { label: "Region", options: ["japan", "us"], value: "japan" },
        },
        {
          id: "tbl",
          type: "presentSpreadsheet",
          props: {},
          data: { $ref: REF, bind: { region: { $state: "region", values: ["japan", "us"] } } },
        },
      ],
      events: [{ on: "sel.change", emit: "state.set", payload: { key: "region", value: "$value" } }],
    });
    const surface = mount(spec, { binding });
    await tick();
    expect(resolved).toEqual([REF]);

    // The select's displayed value follows state. Change to us → state.set → effective ref re-resolution.
    const select = byKohaku(surface, "sel") as HTMLSelectElement;
    expect(select.value).toBe("japan");
    select.value = "us";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    expect(resolved).toEqual([REF, "query://sales/records?region=us"]);
    // Following state, the select value stays us
    expect((byKohaku(surface, "sel") as HTMLSelectElement).value).toBe("us");
  });
});

describe("Phase 2: presentList", () => {
  it("substitutes $row into the row template, and rows become interactive when itemClick is declared", async () => {
    const binding: BindingClient = {
      async resolve() {
        return tableData([
          { region: "Tokyo", amount: 10 },
          { region: "Osaka", amount: 20 },
        ]);
      },
      async invokeAction() {
        return { result: null };
      },
    };
    const REF = "query://sales/list";
    const spec = buildSpec({
      dataVersion: "v1",
      refVersions: { [REF]: "v1" },
      components: [
        { id: "root", type: "presentList", props: {}, data: { $ref: REF }, children: ["row"] },
        { id: "row", type: "text.heading", props: { text: "$row.region", level: 3 } },
      ],
      events: [{ on: "root.itemClick", emit: "intent.replace", payload: { region: "$row.region" } }],
    });
    const events: SurfaceEvent[] = [];
    const surface = mount(spec, { binding, onEvent: (e) => events.push(e) });
    await tick();
    const list = byKohaku(surface, "root")!;
    const items = [...list.querySelectorAll('[role="listitem"]')];
    expect(items.length).toBe(2);
    // $row.region has been substituted into each row's heading
    expect(items.map((i) => i.textContent)).toEqual(["Tokyo", "Osaka"]);
    expect((items[0] as HTMLElement).tabIndex).toBe(0);

    // A row click forwards itemClick including the row context
    (items[1] as HTMLElement).click();
    expect(events).toEqual([
      expect.objectContaining({ componentId: "root", on: "root.itemClick", payload: { region: "Osaka" } }),
    ]);
  });
});

describe("Phase 2: presentSpreadsheet", () => {
  it("local sort: clicking a header changes aria-sort and row order", async () => {
    const binding: BindingClient = {
      async resolve() {
        return tableData([
          { region: "b", amount: 30 },
          { region: "a", amount: 10 },
          { region: "c", amount: 20 },
        ]);
      },
      async invokeAction() {
        return { result: null };
      },
    };
    const REF = "query://sales/table";
    const spec = buildSpec({
      dataVersion: "v1",
      refVersions: { [REF]: "v1" },
      components: [{ id: "root", type: "presentSpreadsheet", props: {}, data: { $ref: REF } }],
    });
    const surface = mount(spec, { binding });
    await tick();
    // Since the whole table element is swapped on every sort, re-query the DOM each time.
    const amountBtn = (): HTMLButtonElement =>
      [...byKohaku(surface, "root")!.querySelectorAll("th button")][1] as HTMLButtonElement;
    const amountTh = (): HTMLElement => byKohaku(surface, "root")!.querySelectorAll("th")[1]!;
    const firstCol = (): (string | null)[] =>
      [...byKohaku(surface, "root")!.querySelectorAll("tbody tr")].map(
        (tr) => tr.querySelector("td")!.textContent,
      );

    amountBtn().click(); // desc
    expect(amountTh().getAttribute("aria-sort")).toBe("descending");
    expect(firstCol()).toEqual(["b", "c", "a"]); // amount 30,20,10

    amountBtn().click(); // asc
    expect(amountTh().getAttribute("aria-sort")).toBe("ascending");
    expect(firstCol()).toEqual(["a", "c", "b"]); // amount 10,20,30
  });

  it("serverSide: initial fetch with page.limit, then re-fetch with cursor on next", async () => {
    const opts: ResolveOptions[] = [];
    const binding: BindingClient = {
      async resolve(_ref, o?: ResolveOptions) {
        opts.push(o ?? {});
        const cursor = o?.page?.cursor;
        return tableData([{ region: cursor ?? "first", amount: 1 }], {
          total: 5,
          // Only the first page (no cursor) has a continuation.
          nextCursor: cursor == null ? "cursor-2" : undefined,
        });
      },
      async invokeAction() {
        return { result: null };
      },
    };
    const REF = "query://sales/big";
    const spec = buildSpec({
      dataVersion: "v1",
      refVersions: { [REF]: "v1" },
      components: [
        {
          id: "root",
          type: "presentSpreadsheet",
          props: { serverSide: true, pageSize: 2 },
          data: { $ref: REF },
        },
      ],
    });
    const surface = mount(spec, { binding });
    await tick();
    // Exactly one initial fetch: since pageSize is declared, the remote controller is active from the
    // very start, so base (BoundDataController) stays disabled and never fetches.
    expect(opts).toHaveLength(1);
    const pageOpts = (): ResolveOptions[] => opts.filter((o) => o.page != null);
    expect(pageOpts()[0]!.page).toEqual({ limit: 2 });

    const nextBtn = [...root(surface).querySelectorAll("button")].find((b) => b.textContent === "Next")!;
    expect(nextBtn).toBeDefined();
    nextBtn.click();
    await tick();
    // The next page has a cursor
    expect(pageOpts()[1]!.page).toEqual({ cursor: "cursor-2", limit: 2 });
  });

  it("serverSide without pageSize/sortBy: base supplies the initial display (b), then interacting (sort) switches to remote and detaches base (c)", async () => {
    const opts: ResolveOptions[] = [];
    const binding: BindingClient = {
      async resolve(_ref, o?: ResolveOptions) {
        opts.push(o ?? {});
        return o?.sort != null
          ? tableData([{ region: "sorted", amount: 1 }])
          : tableData([{ region: "base", amount: 1 }]);
      },
      async invokeAction() {
        return { result: null };
      },
    };
    const REF = "query://sales/plain";
    const spec = buildSpec({
      dataVersion: "v1",
      refVersions: { [REF]: "v1" },
      components: [
        { id: "root", type: "presentSpreadsheet", props: { serverSide: true }, data: { $ref: REF } },
      ],
    });
    const surface = mount(spec, { binding });
    await tick();

    // (b) Neither pageSize nor sortBy is declared and there has been no interaction, so the remote
    // controller never becomes active — base alone supplies the initial display, with a single,
    // un-paged call (base's own shape: only expectedDataVersion, no sort/page).
    expect(opts).toHaveLength(1);
    expect(opts[0]).toEqual({ expectedDataVersion: "v1" });
    const cellText = (): (string | null)[] =>
      [...byKohaku(surface, "root")!.querySelectorAll("tbody td:first-child")].map((td) => td.textContent);
    expect(cellText()).toEqual(["base"]);

    // (c) Once the user interacts (sorts a column), the remote controller becomes active and takes
    // over the display — base is detached and issues no further calls from this point on.
    const sortBtn = byKohaku(surface, "root")!.querySelectorAll("th button")[0] as HTMLButtonElement;
    sortBtn.click();
    await tick();
    expect(cellText()).toEqual(["sorted"]);
    expect(opts.some((o) => o.sort != null)).toBe(true);
    expect(opts.filter((o) => o.expectedDataVersion != null)).toHaveLength(1); // no extra base calls after interaction
  });
});

describe("Phase 2: presentForm write loop", () => {
  it("submit → invokeAction runs directly → success display + invalidates re-resolves a distant table", async () => {
    let version = "v1";
    const captured: (string | undefined)[] = [];
    const REF = "query://sales/summary";
    const binding: BindingClient = {
      async resolve(_ref, o?: ResolveOptions) {
        captured.push(o?.expectedDataVersion);
        return tableData([{ region: version, amount: 1 }], { dataVersion: version });
      },
      async invokeAction(action): Promise<ActionResult> {
        expect(action).toBe("annotate");
        version = "v2";
        return { result: { ok: true }, invalidates: [REF], refVersions: { [REF]: "v2" } };
      },
    };
    const spec = buildSpec({
      dataVersion: "v1",
      refVersions: { [REF]: "v1" },
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["f1", "t1"] },
        {
          id: "f1",
          type: "presentForm",
          props: {
            action: "annotate",
            successMessage: "Saved",
            fields: [{ name: "note", type: "text", label: "Note" }],
          },
        },
        { id: "t1", type: "presentSpreadsheet", props: {}, data: { $ref: REF } },
      ],
      events: [{ on: "f1.submit", emit: "action.invoke", payload: { note: "$value.note" } }],
    });
    const onActionResult = vi.fn();
    const surface = mount(spec, { binding, onActionResult });
    await tick();
    expect(captured).toEqual(["v1"]);

    const form = byKohaku(surface, "f1") as HTMLFormElement;
    const input = form.querySelector("#f1-note") as HTMLInputElement;
    input.value = "Check North America";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();

    // Success message (role=status)
    const status = form.querySelector('[role="status"]')!;
    expect(status.textContent).toBe("Saved");
    expect(onActionResult).toHaveBeenCalledWith(
      expect.objectContaining({ componentId: "f1", action: "annotate", phase: "succeeded" }),
    );
    // The distant table is re-resolved via the invalidate bus (second time, matching target v2)
    expect(captured).toEqual(["v1", "v2"]);
  });

  it("with no BindingClient configured, falls back to onEvent forwarding (state stays idle)", () => {
    const onEvent = vi.fn();
    const spec = buildSpec({
      components: [
        {
          id: "root",
          type: "presentForm",
          props: { action: "annotate", fields: [{ name: "note", type: "text", label: "Note" }] },
        },
      ],
      events: [{ on: "root.submit", emit: "action.invoke", payload: { note: "$value" } }],
    });
    const surface = mount(spec, { onEvent });
    const form = byKohaku(surface, "root") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ componentId: "root", on: "root.submit", emit: "action.invoke" }),
    );
    expect(form.querySelector('[role="status"]')).toBeNull();
  });
});

describe("Phase 2: action.button and control", () => {
  it("without press declared, drop (SPEC-EVT-002); when declared, forward via CustomEvent + onEvent", () => {
    const spec = buildSpec({
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["b1", "b2"] },
        { id: "b1", type: "action.button", props: { label: "undeclared" } },
        { id: "b2", type: "action.button", props: { label: "declared" } },
      ],
      events: [{ on: "b2.press", emit: "intent.replace", payload: { kind: "go" } }],
    });
    const custom: SurfaceEvent[] = [];
    const surface = mount(spec, {});
    surface.addEventListener(KOHAKU_EVENT, (e) => custom.push((e as CustomEvent<SurfaceEvent>).detail));

    (byKohaku(surface, "b1") as HTMLButtonElement).click(); // undeclared → drop
    expect(custom).toEqual([]);
    (byKohaku(surface, "b2") as HTMLButtonElement).click(); // declared → forward
    expect(custom).toEqual([
      expect.objectContaining({ componentId: "b2", on: "b2.press", payload: { kind: "go" } }),
    ]);
  });
});

describe("Phase 2: visibleWhen", () => {
  it("when false, does not build the subtree; mounts/unmounts on state change (via control.select)", () => {
    const spec = buildSpec({
      state: { mode: "hide" },
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["sel", "panel"] },
        { id: "sel", type: "control.select", props: { options: ["hide", "show"], value: "hide" } },
        {
          id: "panel",
          type: "text.heading",
          props: { text: "secret" },
          visibleWhen: { ref: "$state.mode", eq: "show" },
        },
      ],
      events: [{ on: "sel.change", emit: "state.set", payload: { key: "mode", value: "$value" } }],
    });
    const surface = mount(spec, {});
    // Initial "hide" → not built (equivalent to subtree unmount)
    expect(byKohaku(surface, "panel")).toBeNull();

    const select = byKohaku(surface, "sel") as HTMLSelectElement;
    select.value = "show";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    // Matches "show" → mount
    expect(byKohaku(surface, "panel")!.textContent).toBe("secret");

    // Switching back unmounts
    select.value = "hide";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(byKohaku(surface, "panel")).toBeNull();
  });
});
