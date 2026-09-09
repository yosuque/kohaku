import type { BindingClient, ResolveOptions } from "@kohaku-ui/data-binding";
import { parseSpec, type TabularData, type UISpec } from "@kohaku-ui/spec-core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import {
  createDataInvalidationBus,
  DataInvalidationContext,
  RendererProvider,
  SpecView,
} from "../src/index.js";

// PresentSpreadsheet's serverSide: performs sorting/paging not locally but
// by re-fetching via binding.resolve(ref, {page, sort}). The default-false current behavior is covered by use-bound-data.test.

const REF = "query://sales/records?fy=2026";

function pageData(label: string, nextCursor?: string): TabularData {
  return {
    columns: [
      { key: "region", label: "Region", type: "string" },
      { key: "revenue", label: "Revenue", type: "number" },
    ],
    rows: [{ region: label, revenue: 100 }],
    dataVersion: "src@v1",
    total: 3,
    ...(nextCursor != null ? { nextCursor } : {}),
  };
}

/** serverSide with neither pageSize nor sortBy declared — the remote controller is inactive until the user interacts. */
function serverSideSpec(): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "src@v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["t1"] },
      { id: "t1", type: "presentSpreadsheet", props: { serverSide: true }, data: { $ref: REF } },
    ],
    events: [],
    provenance: { tier: "L1", composedBy: "test", cache: "hit" },
  });
}

/** A fake binding that returns page1 for initial (no options), sorted for a sort spec, and page2 for a cursor spec. */
function makeBinding(seen: ResolveOptions[]): BindingClient {
  return {
    async resolve(_ref, opts: ResolveOptions = {}) {
      seen.push(opts);
      if (opts.sort != null) return pageData("sorted", "1:src@v1");
      if (opts.page?.cursor != null) return pageData("page2");
      return pageData("page1", "1:src@v1");
    },
    async invokeAction() {
      return { result: null };
    },
  };
}

const table = () => within(document.querySelector('[data-kohaku="t1"]') as HTMLElement);

describe("PresentSpreadsheet serverSide", () => {
  it("(b) initially base (remote is inactive: no pageSize/sortBy, not interacted yet), and (c) a sort operation switches to remote and detaches base", async () => {
    const seen: ResolveOptions[] = [];
    render(
      <RendererProvider value={{ impls: createCoreRegistry(), binding: makeBinding(seen), theme: {} }}>
        <SpecView spec={serverSideSpec()} />
      </RendererProvider>,
    );

    // (b) With neither pageSize nor sortBy declared and no interaction yet, the remote controller
    // never becomes active — base (useBoundData/BoundDataController) alone supplies the initial
    // display, via its own un-paged/un-sorted call shape (base is disabled only while remote is
    // *actually* active, not merely because serverSide is true, and this must not regress that).
    await waitFor(() => expect(table().getByText("page1")).toBeDefined());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sort).toBeUndefined();
    expect(seen[0]!.page).toBeUndefined();

    // (c) Sort button on the revenue header → the remote controller becomes active (interacted=true),
    // re-fetches with sort={revenue,desc}, and base is detached (no further base calls after this).
    fireEvent.click(table().getByRole("button", { name: /Revenue/ }));
    await waitFor(() => expect(table().getByText("sorted")).toBeDefined());
    expect(seen.some((o) => o.sort?.key === "revenue" && o.sort.dir === "desc")).toBe(true);
    expect(seen.filter((o) => o.sort == null && o.page == null)).toHaveLength(1); // still just the one base call
  });

  it('"Next" passes nextCursor to page.cursor and re-fetches the next page (also (b)/(c) via pagination instead of sort)', async () => {
    const seen: ResolveOptions[] = [];
    render(
      <RendererProvider value={{ impls: createCoreRegistry(), binding: makeBinding(seen), theme: {} }}>
        <SpecView spec={serverSideSpec()} />
      </RendererProvider>,
    );

    // (b) Initial display is base (see the previous test for the detailed rationale).
    await waitFor(() => expect(table().getByText("page1")).toBeDefined());
    expect(seen).toHaveLength(1);

    // (c) The "Next" button (shown once base's data has a nextCursor) → re-fetch with a cursor spec;
    // remote becomes active and base is no longer queried afterward.
    fireEvent.click(table().getByRole("button", { name: "Next" }));
    await waitFor(() => expect(table().getByText("page2")).toBeDefined());
    expect(seen.some((o) => o.page?.cursor === "1:src@v1")).toBe(true);
    expect(seen.filter((o) => o.sort == null && o.page == null)).toHaveLength(1); // still just the one base call
  });
});

// Initial reflection of a declared sortBy / pageSize, and deep comparison on Spec re-delivery.
const REF2 = REF; // use the same ref

/** A Spec declaring serverSide + sortBy (variable dir) + pageSize. */
function sortedPageSpec(dir: "asc" | "desc" = "desc"): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "src@v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["t1"] },
      {
        id: "t1",
        type: "presentSpreadsheet",
        props: { serverSide: true, sortBy: { field: "revenue", dir }, pageSize: 2 },
        data: { $ref: REF2 },
      },
    ],
    events: [],
    provenance: { tier: "L1", composedBy: "test", cache: "hit" },
  });
}

/** A binding that changes the returned label by whether sort is present (remote-sorted / base-unsorted). Records opts into seen. */
function makeSortBinding(seen: ResolveOptions[]): BindingClient {
  return {
    async resolve(_ref, opts: ResolveOptions = {}) {
      seen.push(opts);
      return pageData(opts.sort != null ? "remote-sorted" : "base-unsorted");
    },
    async invokeAction() {
      return { result: null };
    },
  };
}

describe("PresentSpreadsheet serverSide (initial reflection of declared sortBy/pageSize)", () => {
  it("fetches via the remote path (with sort/page) from the initial display, and the displayed data matches the sort indicator", async () => {
    const seen: ResolveOptions[] = [];
    render(
      <RendererProvider value={{ impls: createCoreRegistry(), binding: makeSortBinding(seen), theme: {} }}>
        <SpecView spec={sortedPageSpec("desc")} />
      </RendererProvider>,
    );

    // The initial display is the remote (sorted) result, not base (unsorted).
    await waitFor(() => expect(table().getByText("remote-sorted")).toBeDefined());
    expect(table().queryByText("base-unsorted")).toBeNull();

    // (a) sortBy/pageSize are declared, so the remote controller is active from the very first render:
    // base is disabled from the start and never calls binding.resolve at all — exactly one initial
    // fetch, the remote (sorted/paged) one.
    expect(seen).toHaveLength(1);

    // The remote call is passed the declared sort and pageSize.
    const remote = seen.find((o) => o.sort != null);
    expect(remote?.sort).toEqual({ key: "revenue", dir: "desc" });
    expect(remote?.page?.limit).toBe(2);

    // The sort indicator (aria-sort) lights up descending on the revenue column = matches the displayed data (remote).
    const revenueTh = table()
      .getAllByRole("columnheader")
      .find((th) => /Revenue/.test(th.textContent ?? ""));
    expect(revenueTh?.getAttribute("aria-sort")).toBe("descending");
  });

  it("a change in sortBy content (Spec re-delivery) reflects the new sort, and identical content does not re-fetch", async () => {
    const seen: ResolveOptions[] = [];
    const binding = makeSortBinding(seen);
    const impls = createCoreRegistry();
    const { rerender } = render(
      <RendererProvider value={{ impls, binding, theme: {} }}>
        <SpecView spec={sortedPageSpec("desc")} />
      </RendererProvider>,
    );
    await waitFor(() => expect(table().getByText("remote-sorted")).toBeDefined());
    const descCalls = seen.filter((o) => o.sort?.dir === "desc").length;
    expect(descCalls).toBeGreaterThan(0);
    expect(seen.some((o) => o.sort?.dir === "asc")).toBe(false);

    // (a) Same-content re-delivery: even with a new sortBy object (different reference), it does not misjudge as "operated" and does not re-fetch.
    rerender(
      <RendererProvider value={{ impls, binding, theme: {} }}>
        <SpecView spec={sortedPageSpec("desc")} />
      </RendererProvider>,
    );
    expect(seen.filter((o) => o.sort?.dir === "desc").length).toBe(descCalls);

    // (b) If the content changes (desc→asc), re-fetch remote with the new sort.
    rerender(
      <RendererProvider value={{ impls, binding, theme: {} }}>
        <SpecView spec={sortedPageSpec("asc")} />
      </RendererProvider>,
    );
    await waitFor(() => expect(seen.some((o) => o.sort?.dir === "asc")).toBe(true));
  });
});

// V3: data.bind + $state — the effective ref (not just the raw $ref) drives serverSide refetches.
const REF_JAPAN = "query://sales/records?fy=2026&region=japan";
const REF_EUROPE = "query://sales/records?fy=2026&region=europe";

/** A cross-filter Spec: control.select (region) + a serverSide presentSpreadsheet bound to $state.region. */
function boundServerSideSpec(): UISpec {
  return parseSpec({
    kohaku: "0.2",
    intent: { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "src@v1",
    state: { region: "japan" },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["filter", "t1"] },
      {
        id: "filter",
        type: "control.select",
        props: {
          label: "Region",
          value: "japan",
          options: [
            { value: "japan", label: "Japan" },
            { value: "europe", label: "Europe" },
          ],
        },
      },
      {
        id: "t1",
        type: "presentSpreadsheet",
        props: { serverSide: true },
        data: {
          $ref: REF_JAPAN,
          bind: { region: { $state: "region", values: ["japan", "europe"] } },
        },
      },
    ],
    events: [{ on: "filter.change", emit: "state.set", payload: { key: "region", value: "$value" } }],
    provenance: { tier: "L0", composedBy: "test", cache: "fixated" },
  });
}

/** Records (ref, opts) for every resolve() call; the label distinguishes which ref variant answered. */
function makeRefTrackingBinding(seen: { ref: string; opts: ResolveOptions }[]): BindingClient {
  return {
    async resolve(refInput, opts: ResolveOptions = {}) {
      const ref = typeof refInput === "string" ? refInput : refInput.$ref;
      seen.push({ ref, opts });
      return pageData(ref === REF_EUROPE ? "europe-page" : "japan-page", "1:src@v1");
    },
    async invokeAction() {
      return { result: null };
    },
  };
}

describe("PresentSpreadsheet serverSide (V3: data.bind + $state switches the ref the remote controller targets)", () => {
  it("toggleSort re-fetches against the new effective ref after a $state change (not the stale ref from construction)", async () => {
    const seen: { ref: string; opts: ResolveOptions }[] = [];
    render(
      <RendererProvider
        value={{ impls: createCoreRegistry(), binding: makeRefTrackingBinding(seen), theme: {} }}
      >
        <SpecView spec={boundServerSideSpec()} />
      </RendererProvider>,
    );
    await waitFor(() => expect(table().getByText("japan-page")).toBeDefined());
    expect(seen.every((c) => c.ref === REF_JAPAN)).toBe(true);

    // Switch the region filter → $state.region = "europe" → the spreadsheet's effective ref follows via setRef.
    const select = screen.getByRole("combobox", { name: "Region" }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "europe" } });
    await waitFor(() => expect(table().getByText("europe-page")).toBeDefined());
    expect(seen[seen.length - 1]!.ref).toBe(REF_EUROPE);

    // A user sort operation now must resolve against the new (europe) ref, not snap back to japan.
    fireEvent.click(table().getByRole("button", { name: /Revenue/ }));
    await waitFor(() => expect(seen.some((c) => c.ref === REF_EUROPE && c.opts.sort != null)).toBe(true));
    expect(seen.some((c) => c.ref === REF_JAPAN && c.opts.sort != null)).toBe(false);
  });

  it("goNextPage re-fetches against the new effective ref after a $state change", async () => {
    const seen: { ref: string; opts: ResolveOptions }[] = [];
    render(
      <RendererProvider
        value={{ impls: createCoreRegistry(), binding: makeRefTrackingBinding(seen), theme: {} }}
      >
        <SpecView spec={boundServerSideSpec()} />
      </RendererProvider>,
    );
    await waitFor(() => expect(table().getByText("japan-page")).toBeDefined());

    const select = screen.getByRole("combobox", { name: "Region" }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "europe" } });
    await waitFor(() => expect(table().getByText("europe-page")).toBeDefined());

    fireEvent.click(table().getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(seen.some((c) => c.ref === REF_EUROPE && c.opts.page?.cursor === "1:src@v1")).toBe(true),
    );
    expect(seen.some((c) => c.ref === REF_JAPAN && c.opts.page?.cursor != null)).toBe(false);
  });
});

describe("PresentSpreadsheet serverSide (write invalidation while showing remote)", () => {
  /** A binding that returns versioned data (its content changes with versionRef.v). */
  function makeInvalidationBinding(seen: ResolveOptions[], versionRef: { v: string }): BindingClient {
    return {
      async resolve(_ref, opts: ResolveOptions = {}) {
        seen.push(opts);
        return {
          columns: [
            { key: "region", label: "Region", type: "string" },
            { key: "revenue", label: "Revenue", type: "number" },
          ],
          rows: [{ region: `data-${versionRef.v}`, revenue: 100 }],
          dataVersion: versionRef.v,
          total: 1,
        };
      },
      async invokeAction() {
        return { result: null };
      },
    };
  }

  it("an invalidation event after a sort operation re-fetches remote and shows the new data (cursor reset / sort preserved)", async () => {
    const seen: ResolveOptions[] = [];
    const versionRef = { v: "v1" };
    const bus = createDataInvalidationBus();
    render(
      <RendererProvider
        value={{ impls: createCoreRegistry(), binding: makeInvalidationBinding(seen, versionRef), theme: {} }}
      >
        {/* Insert our own bus inside so the test can publish (overriding RendererProvider's built-in bus). */}
        <DataInvalidationContext.Provider value={bus}>
          <SpecView spec={serverSideSpec()} />
        </DataInvalidationContext.Provider>
      </RendererProvider>,
    );

    // Initial base (v1) — serverSideSpec() declares neither pageSize nor sortBy, so the remote
    // controller starts inactive and base supplies the display until the sort below activates it.
    await waitFor(() => expect(table().getByText("data-v1")).toBeDefined());

    // Sort on the revenue header → transition to remote display (data version is still v1).
    fireEvent.click(table().getByRole("button", { name: /Revenue/ }));
    await waitFor(() => expect(seen.some((o) => o.sort != null)).toBe(true));
    const sortCallsBefore = seen.filter((o) => o.sort != null).length;

    // A write advances the data version and publishes invalidation of its own ref.
    versionRef.v = "v2";
    act(() => bus.publish({ refs: [REF] }));

    // remote is re-fetched and the new data (v2) is displayed.
    await waitFor(() => expect(table().getByText("data-v2")).toBeDefined());
    // The re-fetch keeps sort and resets cursor to the head (undefined).
    const lastSortCall = [...seen].reverse().find((o) => o.sort != null);
    expect(lastSortCall?.page?.cursor).toBeUndefined();
    expect(seen.filter((o) => o.sort != null).length).toBeGreaterThan(sortCallsBefore);
  });
});
