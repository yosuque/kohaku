// React ⇄ WC parity of the serverSide spreadsheet (characterization).
// Both renderers double-implement sort / cursor / interacted / invalidation subscription / last-wins in different idioms.
// Driven by the same Spec and the same resolve stub, this verifies the semantic equivalence of refetch query arguments and rendered rows.
// A safety net for the current implementation (for the upcoming state-machine refactor). Cases where a difference is found are not included but reported.

import type { ActionResult, BindingClient, ResolveOptions } from "@kohaku-ui/data-binding";
import { parseSpec, type TabularData, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPair,
  flushReact,
  normalize,
  renderReact,
  renderWc,
  type SemanticNode,
  tick,
} from "./render-both.js";

const REF = "query://sales/records?fy=2026";
const INTENT = { canonical: "parity.ss.spreadsheet", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L1", composedBy: "parity", cache: "hit" } as const;

function pageData(label: string, extra: Partial<TabularData> = {}): TabularData {
  return {
    columns: [
      { key: "region", label: "Region", type: "string" },
      { key: "revenue", label: "Revenue", type: "number" },
    ],
    rows: [{ region: label, revenue: 100 }],
    dataVersion: "src@v1",
    total: 5,
    ...extra,
  };
}

/**
 * serverSide + pageSize. The remote path is active from the start; base (useBoundData /
 * BoundDataController) is skipped entirely for serverSide, so this is the sole fetch source —
 * see the "single initial fetch" assertion in the first test below.
 */
function serverSideSpec(extraProps: Record<string, unknown> = {}): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "src@v1",
    refVersions: { [REF]: "src@v1" },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["t1"] },
      {
        id: "t1",
        type: "presentSpreadsheet",
        props: { serverSide: true, pageSize: 2, ...extraProps },
        data: { $ref: REF },
      },
    ],
    events: [],
    provenance: PROVENANCE,
  });
}

/** Triggers invalidation via invokeAction.invalidates (delivering it to both renderers' internal buses). */
function serverSideWithFormSpec(): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "src@v1",
    refVersions: { [REF]: "src@v1" },
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
      {
        id: "t1",
        type: "presentSpreadsheet",
        props: { serverSide: true, pageSize: 2 },
        data: { $ref: REF },
      },
    ],
    events: [{ on: "f1.submit", emit: "action.invoke", payload: { note: "$value.note" } }],
    provenance: PROVENANCE,
  });
}

/**
 * Extracts only the remote calls (sort / page present). base (which only ever sent expectedDataVersion,
 * no sort/page) is skipped for serverSide, so this is normally a no-op filter — kept as a defensive
 * filter and to keep the assertions below expressive.
 */
function remoteOpts(seen: ResolveOptions[]): ResolveOptions[] {
  return seen.filter((o) => o.sort != null || o.page != null);
}

function rowLabel(root: ParentNode): string | null {
  return root.querySelector('[data-kohaku="t1"] tbody td')?.textContent ?? null;
}

function tableNode(root: ParentNode): SemanticNode {
  const el = root.querySelector('[data-kohaku="t1"]');
  if (el == null) throw new Error("spreadsheet node not found");
  return normalize(el);
}

function clickSortRevenue(root: ParentNode, via: "react" | "wc"): void {
  const btn = [...root.querySelectorAll('[data-kohaku="t1"] th button')].find((b) =>
    /Revenue/.test(b.textContent ?? ""),
  );
  if (btn == null) throw new Error("revenue sort button not found");
  if (via === "react") fireEvent.click(btn);
  else (btn as HTMLElement).click();
}

function clickPager(root: ParentNode, label: string, via: "react" | "wc"): void {
  const btn = [...root.querySelectorAll('[data-kohaku="t1"] button')].find((b) => b.textContent === label);
  if (btn == null) throw new Error(`pager button not found: ${label}`);
  if (via === "react") fireEvent.click(btn);
  else (btn as HTMLElement).click();
}

/**
 * Default responses: the first page has a nextCursor, a request with cursor returns page2, and one with sort adds "sorted" to the label.
 * If versionRef is present, reflect it in dataVersion / the row label (for the invalidation test).
 */
function makeBinding(seen: ResolveOptions[], versionRef: { v: string } = { v: "src@v1" }): BindingClient {
  return {
    async resolve(_ref, opts: ResolveOptions = {}) {
      seen.push(opts);
      const sorted = opts.sort != null;
      const cursor = opts.page?.cursor;
      const label =
        cursor != null
          ? `page2-${versionRef.v}`
          : sorted
            ? `sorted-${versionRef.v}`
            : `page1-${versionRef.v}`;
      return pageData(label, {
        dataVersion: versionRef.v,
        nextCursor: cursor == null ? "1:src@v1" : undefined,
      });
    },
    async invokeAction(): Promise<ActionResult> {
      return { result: null };
    },
  };
}

describe("serverSide spreadsheet parity: React ⇄ WC", () => {
  afterEach(() => cleanupPair());

  it("initial render: remote sort/cursor/limit arguments match and rendered rows are semantically equivalent", async () => {
    const reactSeen: ResolveOptions[] = [];
    const wcSeen: ResolveOptions[] = [];
    const spec = serverSideSpec();

    const { container } = await renderReact(spec, { binding: () => makeBinding(reactSeen) });
    const { surface } = await renderWc(spec, { binding: () => makeBinding(wcSeen) });
    const wcRoot = surface.shadowRoot!;

    expect(rowLabel(container)).toBe("page1-src@v1");
    expect(rowLabel(wcRoot)).toBe(rowLabel(container));

    // Exactly one initial binding.resolve call in each renderer (base is skipped for serverSide, so
    // there is no separate un-paged fetch racing this one).
    expect(reactSeen).toHaveLength(1);
    expect(wcSeen).toHaveLength(1);

    // The initial remote has only page.limit (no sort/cursor).
    expect(remoteOpts(reactSeen)).toEqual([{ page: { limit: 2 } }]);
    expect(remoteOpts(wcSeen)).toEqual(remoteOpts(reactSeen));

    expect(tableNode(wcRoot)).toEqual(tableNode(container));
  });

  it("sort toggle: refetch key/dir and cursor reset match in both", async () => {
    const reactSeen: ResolveOptions[] = [];
    const wcSeen: ResolveOptions[] = [];
    const spec = serverSideSpec();

    const { container } = await renderReact(spec, { binding: () => makeBinding(reactSeen) });
    const { surface } = await renderWc(spec, { binding: () => makeBinding(wcSeen) });
    const wcRoot = surface.shadowRoot!;

    clickSortRevenue(container, "react");
    await flushReact();
    clickSortRevenue(wcRoot, "wc");
    await tick();

    expect(rowLabel(container)).toBe("sorted-src@v1");
    expect(rowLabel(wcRoot)).toBe(rowLabel(container));

    const reactSort = remoteOpts(reactSeen).filter((o) => o.sort != null);
    const wcSort = remoteOpts(wcSeen).filter((o) => o.sort != null);
    expect(reactSort).toEqual([{ sort: { key: "revenue", dir: "desc" }, page: { limit: 2 } }]);
    expect(wcSort).toEqual(reactSort);
    // On a sort change, no cursor is attached (returns to the first page).
    expect(reactSort.every((o) => o.page?.cursor == null)).toBe(true);

    expect(tableNode(wcRoot)).toEqual(tableNode(container));
  });

  it("pagination: next / first-page cursor arguments match in both", async () => {
    const reactSeen: ResolveOptions[] = [];
    const wcSeen: ResolveOptions[] = [];
    const spec = serverSideSpec();

    const { container } = await renderReact(spec, { binding: () => makeBinding(reactSeen) });
    const { surface } = await renderWc(spec, { binding: () => makeBinding(wcSeen) });
    const wcRoot = surface.shadowRoot!;

    // Next
    clickPager(container, "Next", "react");
    await flushReact();
    clickPager(wcRoot, "Next", "wc");
    await tick();

    expect(rowLabel(container)).toBe("page2-src@v1");
    expect(rowLabel(wcRoot)).toBe(rowLabel(container));

    const reactNext = remoteOpts(reactSeen).find((o) => o.page?.cursor != null);
    const wcNext = remoteOpts(wcSeen).find((o) => o.page?.cursor != null);
    expect(reactNext).toEqual({ page: { cursor: "1:src@v1", limit: 2 } });
    expect(wcNext).toEqual(reactNext);

    // Return to the first page
    const reactBeforeFirst = remoteOpts(reactSeen).length;
    const wcBeforeFirst = remoteOpts(wcSeen).length;
    clickPager(container, "First page", "react");
    await flushReact();
    clickPager(wcRoot, "First page", "wc");
    await tick();

    expect(rowLabel(container)).toBe("page1-src@v1");
    expect(rowLabel(wcRoot)).toBe(rowLabel(container));

    const reactFirst = remoteOpts(reactSeen).slice(reactBeforeFirst);
    const wcFirst = remoteOpts(wcSeen).slice(wcBeforeFirst);
    // No cursor, limit retained (the first page).
    expect(reactFirst).toEqual([{ page: { limit: 2 } }]);
    expect(wcFirst).toEqual(reactFirst);

    expect(tableNode(wcRoot)).toEqual(tableNode(container));
  });

  it("invalidation: post-write refetch keeps sort and resets cursor, matching in both", async () => {
    const reactSeen: ResolveOptions[] = [];
    const wcSeen: ResolveOptions[] = [];
    const reactVersion = { v: "src@v1" };
    const wcVersion = { v: "src@v1" };
    const spec = serverSideWithFormSpec();

    const reactBinding = (): BindingClient => {
      const base = makeBinding(reactSeen, reactVersion);
      return {
        resolve: base.resolve.bind(base),
        async invokeAction(): Promise<ActionResult> {
          reactVersion.v = "src@v2";
          return { result: { ok: true }, invalidates: [REF], refVersions: { [REF]: "src@v2" } };
        },
      };
    };
    const wcBinding = (): BindingClient => {
      const base = makeBinding(wcSeen, wcVersion);
      return {
        resolve: base.resolve.bind(base),
        async invokeAction(): Promise<ActionResult> {
          wcVersion.v = "src@v2";
          return { result: { ok: true }, invalidates: [REF], refVersions: { [REF]: "src@v2" } };
        },
      };
    };

    const { container } = await renderReact(spec, { binding: reactBinding });
    const { surface } = await renderWc(spec, { binding: wcBinding });
    const wcRoot = surface.shadowRoot!;

    // Sort to activate the remote path + a sorted display, then invalidate.
    clickSortRevenue(container, "react");
    await flushReact();
    clickSortRevenue(wcRoot, "wc");
    await tick();
    expect(rowLabel(container)).toBe("sorted-src@v1");

    // Invalidating after advancing to the next page makes the cursor reset easier to observe.
    clickPager(container, "Next", "react");
    await flushReact();
    clickPager(wcRoot, "Next", "wc");
    await tick();
    expect(rowLabel(container)).toBe("page2-src@v1");

    const reactSortBefore = remoteOpts(reactSeen).filter((o) => o.sort != null).length;
    const wcSortBefore = remoteOpts(wcSeen).filter((o) => o.sort != null).length;

    // Form submit → invalidates
    fireEvent.change(container.querySelector("#f1-note") as HTMLInputElement, {
      target: { value: "note" },
    });
    fireEvent.submit(container.querySelector('[data-kohaku="f1"]') as HTMLFormElement);
    await flushReact();

    const wcNote = wcRoot.querySelector("#f1-note") as HTMLInputElement;
    wcNote.value = "note";
    wcNote.dispatchEvent(new Event("input", { bubbles: true }));
    (wcRoot.querySelector('[data-kohaku="f1"]') as HTMLFormElement).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await tick();

    expect(rowLabel(container)).toBe("sorted-src@v2");
    expect(rowLabel(wcRoot)).toBe(rowLabel(container));

    const reactAfter = remoteOpts(reactSeen)
      .slice(0)
      .reverse()
      .find((o) => o.sort != null);
    const wcAfter = remoteOpts(wcSeen)
      .slice(0)
      .reverse()
      .find((o) => o.sort != null);
    // sort is retained; cursor returns to the first page (undefined).
    expect(reactAfter).toEqual({ sort: { key: "revenue", dir: "desc" }, page: { limit: 2 } });
    expect(wcAfter).toEqual(reactAfter);
    expect(reactAfter?.page?.cursor).toBeUndefined();
    expect(remoteOpts(reactSeen).filter((o) => o.sort != null).length).toBeGreaterThan(reactSortBefore);
    expect(remoteOpts(wcSeen).filter((o) => o.sort != null).length).toBeGreaterThan(wcSortBefore);

    expect(tableNode(wcRoot)).toEqual(tableNode(container));
  });

  it("last-wins: a delayed stale response does not overwrite a newer response (both)", async () => {
    // Since the table shows loading during a refetch and the sort button disappears, the second request
    // is triggered by the adjacent form's invalidates (deterministic; no real timer needed).
    type Deferred = {
      opts: ResolveOptions;
      resolve: (data: TabularData) => void;
    };

    function makeControllable(seen: ResolveOptions[]): {
      binding: BindingClient;
      pending: Deferred[];
      deferRemote: { enabled: boolean };
    } {
      const pending: Deferred[] = [];
      const deferRemote = { enabled: false };
      const binding: BindingClient = {
        async resolve(_ref, opts: ResolveOptions = {}) {
          seen.push(opts);
          const isRemote = opts.sort != null || opts.page != null;
          // base (expectedDataVersion only) is always immediate. Only gate the remote.
          if (!isRemote || !deferRemote.enabled) {
            const cursor = opts.page?.cursor;
            const sorted = opts.sort != null;
            return pageData(cursor != null ? "page2" : sorted ? "sorted" : "page1", {
              nextCursor: cursor == null ? "1:src@v1" : undefined,
            });
          }
          let resolve!: (data: TabularData) => void;
          const promise = new Promise<TabularData>((r) => {
            resolve = r;
          });
          pending.push({ opts, resolve });
          return promise;
        },
        async invokeAction(): Promise<ActionResult> {
          return { result: { ok: true }, invalidates: [REF], refVersions: { [REF]: "src@v2" } };
        },
      };
      return { binding, pending, deferRemote };
    }

    const reactSeen: ResolveOptions[] = [];
    const wcSeen: ResolveOptions[] = [];
    const reactCtl = makeControllable(reactSeen);
    const wcCtl = makeControllable(wcSeen);
    const spec = serverSideWithFormSpec();

    const { container } = await renderReact(spec, { binding: () => reactCtl.binding });
    const { surface } = await renderWc(spec, { binding: () => wcCtl.binding });
    const wcRoot = surface.shadowRoot!;
    expect(rowLabel(container)).toBe("page1");
    expect(rowLabel(wcRoot)).toBe("page1");

    // Make only the remote refetch complete manually.
    reactCtl.deferRemote.enabled = true;
    wcCtl.deferRemote.enabled = true;

    // Old request: sort refetch (stays loading, uncompleted).
    clickSortRevenue(container, "react");
    await flushReact();
    clickSortRevenue(wcRoot, "wc");
    await tick();
    expect(reactCtl.pending.length).toBe(1);
    expect(wcCtl.pending.length).toBe(1);

    // New request: form submit → invalidates → refetch with cursor reset (the table stays loading while the form remains operable).
    fireEvent.change(container.querySelector("#f1-note") as HTMLInputElement, {
      target: { value: "note" },
    });
    fireEvent.submit(container.querySelector('[data-kohaku="f1"]') as HTMLFormElement);
    await flushReact();

    const wcNote = wcRoot.querySelector("#f1-note") as HTMLInputElement;
    wcNote.value = "note";
    wcNote.dispatchEvent(new Event("input", { bubbles: true }));
    (wcRoot.querySelector('[data-kohaku="f1"]') as HTMLFormElement).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await tick();

    expect(reactCtl.pending.length).toBe(2);
    expect(wcCtl.pending.length).toBe(2);

    // Complete the new response first.
    reactCtl.pending[1]!.resolve(pageData("fresh", { nextCursor: "1:src@v1", dataVersion: "src@v2" }));
    wcCtl.pending[1]!.resolve(pageData("fresh", { nextCursor: "1:src@v1", dataVersion: "src@v2" }));
    await flushReact();
    await tick();
    expect(rowLabel(container)).toBe("fresh");
    expect(rowLabel(wcRoot)).toBe("fresh");

    // Even if the old response arrives later, it does not overwrite.
    reactCtl.pending[0]!.resolve(pageData("stale", { nextCursor: "1:src@v1", dataVersion: "src@v1" }));
    wcCtl.pending[0]!.resolve(pageData("stale", { nextCursor: "1:src@v1", dataVersion: "src@v1" }));
    await flushReact();
    await tick();
    expect(rowLabel(container)).toBe("fresh");
    expect(rowLabel(wcRoot)).toBe("fresh");

    // The new request's arguments also match (sort retained, no cursor, limit retained).
    expect(reactCtl.pending[1]!.opts).toEqual({
      sort: { key: "revenue", dir: "desc" },
      page: { limit: 2 },
    });
    expect(wcCtl.pending[1]!.opts).toEqual(reactCtl.pending[1]!.opts);
  });
});

// The remote controller must follow the node's *effective* ref (data.bind resolved
// against $state), not stay pinned to the raw $ref it was constructed with — see
// packages/renderer-core/src/spreadsheet-remote-controller.ts's setRef and the wiring in
// renderer-react's use-spreadsheet-remote.ts / renderer-wc's parts/spreadsheet.ts.
const REF_JAPAN = "query://sales/records?fy=2026&region=japan";
const REF_EUROPE = "query://sales/records?fy=2026&region=europe";

/** control.select (region) + a serverSide presentSpreadsheet bound to $state.region. */
function boundServerSideSpec(): UISpec {
  return parseSpec({
    kohaku: "0.2",
    intent: INTENT,
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
        data: { $ref: REF_JAPAN, bind: { region: { $state: "region", values: ["japan", "europe"] } } },
      },
    ],
    events: [{ on: "filter.change", emit: "state.set", payload: { key: "region", value: "$value" } }],
    provenance: PROVENANCE,
  });
}

/** Records (ref, opts) for every resolve() call; the row label reveals which ref variant answered. */
function makeRefTrackingBinding(seen: { ref: string; opts: ResolveOptions }[]): BindingClient {
  return {
    async resolve(refInput, opts: ResolveOptions = {}) {
      const ref = typeof refInput === "string" ? refInput : refInput.$ref;
      seen.push({ ref, opts });
      return pageData(ref === REF_EUROPE ? "europe-page" : "japan-page", { nextCursor: "1:src@v1" });
    },
    async invokeAction(): Promise<ActionResult> {
      return { result: null };
    },
  };
}

function selectRegion(root: ParentNode, value: string, via: "react" | "wc"): void {
  const select = root.querySelector('select[aria-label="Region"]') as HTMLSelectElement;
  if (via === "react") {
    fireEvent.change(select, { target: { value } });
  } else {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

describe("serverSide spreadsheet parity: data.bind + $state switches the ref the remote controller targets", () => {
  afterEach(() => cleanupPair());

  it("toggleSort re-fetches against the new effective ref after a $state change, matching in both", async () => {
    const reactSeen: { ref: string; opts: ResolveOptions }[] = [];
    const wcSeen: { ref: string; opts: ResolveOptions }[] = [];
    const spec = boundServerSideSpec();

    const { container } = await renderReact(spec, { binding: () => makeRefTrackingBinding(reactSeen) });
    const { surface } = await renderWc(spec, { binding: () => makeRefTrackingBinding(wcSeen) });
    const wcRoot = surface.shadowRoot!;

    expect(rowLabel(container)).toBe("japan-page");
    expect(rowLabel(wcRoot)).toBe("japan-page");

    selectRegion(container, "europe", "react");
    await flushReact();
    selectRegion(wcRoot, "europe", "wc");
    await tick();
    expect(rowLabel(container)).toBe("europe-page");
    expect(rowLabel(wcRoot)).toBe("europe-page");
    expect(reactSeen.every((c) => c.ref !== REF_JAPAN || c.opts.sort == null)).toBe(true);

    clickSortRevenue(container, "react");
    await flushReact();
    clickSortRevenue(wcRoot, "wc");
    await tick();

    expect(rowLabel(container)).toBe("europe-page");
    expect(rowLabel(wcRoot)).toBe("europe-page");
    const reactSortCall = reactSeen.find((c) => c.opts.sort != null);
    const wcSortCall = wcSeen.find((c) => c.opts.sort != null);
    expect(reactSortCall?.ref).toBe(REF_EUROPE);
    expect(wcSortCall?.ref).toBe(REF_EUROPE);
    expect(reactSeen.some((c) => c.ref === REF_JAPAN && c.opts.sort != null)).toBe(false);
    expect(wcSeen.some((c) => c.ref === REF_JAPAN && c.opts.sort != null)).toBe(false);
  });

  it("goNextPage re-fetches against the new effective ref after a $state change, matching in both", async () => {
    const reactSeen: { ref: string; opts: ResolveOptions }[] = [];
    const wcSeen: { ref: string; opts: ResolveOptions }[] = [];
    const spec = boundServerSideSpec();

    const { container } = await renderReact(spec, { binding: () => makeRefTrackingBinding(reactSeen) });
    const { surface } = await renderWc(spec, { binding: () => makeRefTrackingBinding(wcSeen) });
    const wcRoot = surface.shadowRoot!;

    selectRegion(container, "europe", "react");
    await flushReact();
    selectRegion(wcRoot, "europe", "wc");
    await tick();
    expect(rowLabel(container)).toBe("europe-page");
    expect(rowLabel(wcRoot)).toBe("europe-page");

    clickPager(container, "Next", "react");
    await flushReact();
    clickPager(wcRoot, "Next", "wc");
    await tick();

    const reactNext = reactSeen.find((c) => c.opts.page?.cursor != null);
    const wcNext = wcSeen.find((c) => c.opts.page?.cursor != null);
    expect(reactNext?.ref).toBe(REF_EUROPE);
    expect(wcNext?.ref).toBe(REF_EUROPE);
    expect(reactSeen.some((c) => c.ref === REF_JAPAN && c.opts.page?.cursor != null)).toBe(false);
    expect(wcSeen.some((c) => c.ref === REF_JAPAN && c.opts.page?.cursor != null)).toBe(false);
  });
});
