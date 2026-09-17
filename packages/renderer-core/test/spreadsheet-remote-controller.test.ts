import type { BindingClient, ResolveOptions } from "@kohaku-ui/data-binding";
import type { TabularData } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  createDataInvalidationBus,
  createSpreadsheetRemoteController,
  type SpreadsheetRemoteController,
} from "../src/index.js";

// Characterization tests for the serverSide spreadsheet refetch state machine, written
// BEFORE extracting useSpreadsheetRemote (renderer-react) so the behavior it wraps is
// pinned down independently of React. Mirrors the fake-binding style used by
// spreadsheet-serverside.test.tsx (apps: renderer-react) and bound-data-controller.test.ts.

const REF = "query://sales/records?fy=2026";

const tick = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

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

/**
 * A controllable-latency fake binding: each resolve(ref, opts) call gets its own deferred,
 * addressable by call index (0-based, in call order) so a test can resolve calls out of order
 * to exercise last-wins sequencing.
 */
function makeDeferredBinding(): {
  binding: BindingClient;
  seen: ResolveOptions[];
  resolveAt: (index: number, data: TabularData) => void;
  rejectAt: (index: number, err: unknown) => void;
} {
  const seen: ResolveOptions[] = [];
  const pending: { resolve: (d: TabularData) => void; reject: (e: unknown) => void; settled: boolean }[] = [];
  const binding: BindingClient = {
    async resolve(_ref, opts: ResolveOptions = {}) {
      seen.push(opts);
      return new Promise<TabularData>((resolve, reject) => {
        pending.push({ resolve, reject, settled: false });
      });
    },
    async invokeAction() {
      return { result: null };
    },
  };
  return {
    binding,
    seen,
    resolveAt(index, data) {
      const p = pending[index];
      if (p == null || p.settled) throw new Error(`no pending resolve() call at index ${index} to satisfy`);
      p.settled = true;
      p.resolve(data);
    },
    rejectAt(index, err) {
      const p = pending[index];
      if (p == null || p.settled) throw new Error(`no pending resolve() call at index ${index} to satisfy`);
      p.settled = true;
      p.reject(err);
    },
  };
}

/** An immediate-resolution fake binding, for tests that don't need to control ordering. */
function makeImmediateBinding(seen: ResolveOptions[]): BindingClient {
  return {
    async resolve(_ref, opts: ResolveOptions = {}) {
      seen.push(opts);
      return opts.sort != null ? pageData("sorted", "1:src@v1") : pageData("page1", "1:src@v1");
    },
    async invokeAction() {
      return { result: null };
    },
  };
}

describe("createSpreadsheetRemoteController: inactive / non-serverSide", () => {
  it("serverSide=false: remote stays null even after start(), and toggleSort just updates sort locally", () => {
    const seen: ResolveOptions[] = [];
    const ctrl = createSpreadsheetRemoteController({
      binding: makeImmediateBinding(seen),
      bus: createDataInvalidationBus(),
      ref: REF,
      pageSize: undefined,
      serverSide: false,
      declaredSort: undefined,
    });
    const stop = ctrl.start();
    expect(ctrl.getSnapshot().remote).toBeNull();
    expect(ctrl.getSnapshot().remoteActive).toBe(false);

    let notified = false;
    ctrl.subscribe(() => {
      notified = true;
    });
    ctrl.toggleSort("revenue");
    expect(notified).toBe(true);
    expect(ctrl.getSnapshot().sort).toEqual({ field: "revenue", dir: "desc" });
    expect(ctrl.getSnapshot().remote).toBeNull();
    expect(seen.length).toBe(0); // never calls binding.resolve when serverSide is false
    stop();
  });

  it("no ref: remote stays null and no binding.resolve call is made", () => {
    const seen: ResolveOptions[] = [];
    const ctrl = createSpreadsheetRemoteController({
      binding: makeImmediateBinding(seen),
      bus: createDataInvalidationBus(),
      ref: undefined,
      pageSize: undefined,
      serverSide: true,
      declaredSort: undefined,
    });
    ctrl.start();
    expect(ctrl.getSnapshot().remote).toBeNull();
    expect(seen.length).toBe(0);
  });

  it("serverSide=true but inactive (no declaredSort/pageSize/interaction): remote stays null and no fetch happens on start()", async () => {
    const seen: ResolveOptions[] = [];
    const ctrl = createSpreadsheetRemoteController({
      binding: makeImmediateBinding(seen),
      bus: createDataInvalidationBus(),
      ref: REF,
      pageSize: undefined,
      serverSide: true,
      declaredSort: undefined,
    });
    ctrl.start();
    await tick();
    expect(ctrl.getSnapshot().remoteActive).toBe(false);
    expect(ctrl.getSnapshot().remote).toBeNull();
    expect(seen.length).toBe(0);
  });
});

describe("createSpreadsheetRemoteController: last-wins sequencing", () => {
  it("an older in-flight response arriving after a newer one is ignored (last-wins by seq)", async () => {
    const { binding, seen, resolveAt } = makeDeferredBinding();
    const ctrl = createSpreadsheetRemoteController({
      binding,
      bus: createDataInvalidationBus(),
      ref: REF,
      pageSize: undefined,
      serverSide: true,
      declaredSort: { field: "revenue", dir: "desc" },
    });
    ctrl.start(); // first fetch (index 0, seq=1), still pending
    await tick();
    expect(seen.length).toBe(1);

    // Trigger a second fetch (index 1, seq=2) before the first resolves.
    ctrl.goFirstPage();
    await tick();
    expect(seen.length).toBe(2);

    // Resolve the newer (second) call first, then the older (first) call.
    resolveAt(1, pageData("second"));
    await tick();
    expect(ctrl.getSnapshot().remote).toEqual({
      status: "ready",
      data: pageData("second"),
    });

    resolveAt(0, pageData("first-stale"));
    await tick();
    // The stale response must not overwrite the newer snapshot.
    expect(ctrl.getSnapshot().remote).toEqual({
      status: "ready",
      data: pageData("second"),
    });
  });

  it("a response arriving after stop() (teardown) is ignored", async () => {
    const { binding, resolveAt } = makeDeferredBinding();
    const ctrl = createSpreadsheetRemoteController({
      binding,
      bus: createDataInvalidationBus(),
      ref: REF,
      pageSize: undefined,
      serverSide: true,
      declaredSort: { field: "revenue", dir: "desc" },
    });
    const stop = ctrl.start();
    await tick();
    stop();
    resolveAt(0, pageData("too-late"));
    await tick();
    expect(ctrl.getSnapshot().remote).toEqual({ status: "loading" });
  });
});

describe("createSpreadsheetRemoteController: syncDeclaredSort", () => {
  it("is a no-op (no notify, no refetch) when the signature is unchanged", async () => {
    const seen: ResolveOptions[] = [];
    const ctrl = createSpreadsheetRemoteController({
      binding: makeImmediateBinding(seen),
      bus: createDataInvalidationBus(),
      ref: REF,
      pageSize: undefined,
      serverSide: true,
      declaredSort: { field: "revenue", dir: "desc" },
    });
    ctrl.start();
    await tick();
    const callsAfterStart = seen.length;

    let notified = false;
    ctrl.subscribe(() => {
      notified = true;
    });
    // A new object, but identical content (value signature, not reference equality).
    ctrl.syncDeclaredSort({ field: "revenue", dir: "desc" });
    await tick();
    expect(notified).toBe(false);
    expect(seen.length).toBe(callsAfterStart);
  });

  it("triggers a refetch and resets cursor/interacted when the signature changes", async () => {
    const seen: ResolveOptions[] = [];
    const ctrl = createSpreadsheetRemoteController({
      binding: makeImmediateBinding(seen),
      bus: createDataInvalidationBus(),
      ref: REF,
      pageSize: undefined,
      serverSide: true,
      declaredSort: { field: "revenue", dir: "desc" },
    });
    ctrl.start();
    await tick();
    ctrl.goNextPage("cursor-1");
    await tick();
    expect(ctrl.getSnapshot().cursor).toBe("cursor-1");
    expect(ctrl.getSnapshot().interacted).toBe(true);

    ctrl.syncDeclaredSort({ field: "revenue", dir: "asc" });
    await tick();
    expect(ctrl.getSnapshot().sort).toEqual({ field: "revenue", dir: "asc" });
    expect(ctrl.getSnapshot().cursor).toBeUndefined();
    expect(ctrl.getSnapshot().interacted).toBe(false);
    expect(seen.some((o) => o.sort?.dir === "asc")).toBe(true);
  });

  it("when serverSide is false, updates sort/cursor/interacted and notifies without calling binding.resolve", () => {
    const seen: ResolveOptions[] = [];
    const ctrl = createSpreadsheetRemoteController({
      binding: makeImmediateBinding(seen),
      bus: createDataInvalidationBus(),
      ref: REF,
      pageSize: undefined,
      serverSide: false,
      declaredSort: { field: "revenue", dir: "desc" },
    });
    ctrl.start();

    let notified = false;
    ctrl.subscribe(() => {
      notified = true;
    });
    ctrl.syncDeclaredSort({ field: "revenue", dir: "asc" });
    expect(notified).toBe(true);
    expect(ctrl.getSnapshot().sort).toEqual({ field: "revenue", dir: "asc" });
    expect(seen.length).toBe(0);
  });
});

describe("createSpreadsheetRemoteController: toggleSort / goFirstPage / goNextPage", () => {
  it("toggleSort returns the resulting SortState (so the caller can emit sortChange with it)", async () => {
    const seen: ResolveOptions[] = [];
    const ctrl = createSpreadsheetRemoteController({
      binding: makeImmediateBinding(seen),
      bus: createDataInvalidationBus(),
      ref: REF,
      pageSize: undefined,
      serverSide: true,
      declaredSort: undefined,
    });
    ctrl.start();
    await tick();

    expect(ctrl.toggleSort("revenue")).toEqual({ field: "revenue", dir: "desc" });
    await tick();
    expect(ctrl.toggleSort("revenue")).toEqual({ field: "revenue", dir: "asc" });
  });

  it("toggleSort on a new column defaults to desc; toggling the same column flips asc<->desc", async () => {
    const seen: ResolveOptions[] = [];
    const ctrl = createSpreadsheetRemoteController({
      binding: makeImmediateBinding(seen),
      bus: createDataInvalidationBus(),
      ref: REF,
      pageSize: undefined,
      serverSide: true,
      declaredSort: undefined,
    });
    ctrl.start();
    await tick();

    ctrl.toggleSort("revenue");
    await tick();
    expect(ctrl.getSnapshot().sort).toEqual({ field: "revenue", dir: "desc" });
    expect(ctrl.getSnapshot().interacted).toBe(true);

    ctrl.toggleSort("revenue");
    await tick();
    expect(ctrl.getSnapshot().sort).toEqual({ field: "revenue", dir: "asc" });

    // Switching to a different column resets to desc.
    ctrl.toggleSort("region");
    await tick();
    expect(ctrl.getSnapshot().sort).toEqual({ field: "region", dir: "desc" });
  });

  it("toggleSort resets cursor and refetches when serverSide", async () => {
    const seen: ResolveOptions[] = [];
    const ctrl = createSpreadsheetRemoteController({
      binding: makeImmediateBinding(seen),
      bus: createDataInvalidationBus(),
      ref: REF,
      pageSize: undefined,
      serverSide: true,
      declaredSort: undefined,
    });
    ctrl.start();
    await tick();
    ctrl.goNextPage("cursor-1");
    await tick();
    expect(ctrl.getSnapshot().cursor).toBe("cursor-1");

    ctrl.toggleSort("revenue");
    await tick();
    expect(ctrl.getSnapshot().cursor).toBeUndefined();
    expect(seen.some((o) => o.sort?.key === "revenue" && o.sort.dir === "desc")).toBe(true);
  });

  it("goFirstPage clears cursor, marks interacted, and refetches", async () => {
    const seen: ResolveOptions[] = [];
    const ctrl = createSpreadsheetRemoteController({
      binding: makeImmediateBinding(seen),
      bus: createDataInvalidationBus(),
      ref: REF,
      pageSize: undefined,
      serverSide: true,
      declaredSort: undefined,
    });
    ctrl.start();
    await tick();
    ctrl.goNextPage("cursor-1");
    await tick();
    const callsBefore = seen.length;

    ctrl.goFirstPage();
    await tick();
    expect(ctrl.getSnapshot().cursor).toBeUndefined();
    expect(ctrl.getSnapshot().interacted).toBe(true);
    expect(seen.length).toBeGreaterThan(callsBefore);
  });

  it("goNextPage sets cursor, marks interacted, and refetches with the given cursor", async () => {
    const seen: ResolveOptions[] = [];
    const ctrl = createSpreadsheetRemoteController({
      binding: makeImmediateBinding(seen),
      bus: createDataInvalidationBus(),
      ref: REF,
      pageSize: undefined,
      serverSide: true,
      declaredSort: undefined,
    });
    ctrl.start();
    await tick();

    ctrl.goNextPage("cursor-2");
    await tick();
    expect(ctrl.getSnapshot().cursor).toBe("cursor-2");
    expect(ctrl.getSnapshot().interacted).toBe(true);
    expect(seen.some((o) => o.page?.cursor === "cursor-2")).toBe(true);
  });
});

describe("createSpreadsheetRemoteController: invalidation bus", () => {
  it("subscribes on start() and refetches (resetting cursor, keeping sort) on publish; unsubscribes on stop()", async () => {
    const seen: ResolveOptions[] = [];
    const bus = createDataInvalidationBus();
    const ctrl: SpreadsheetRemoteController = createSpreadsheetRemoteController({
      binding: makeImmediateBinding(seen),
      bus,
      ref: REF,
      pageSize: undefined,
      serverSide: true,
      declaredSort: { field: "revenue", dir: "desc" },
    });
    const stop = ctrl.start();
    await tick();
    ctrl.goNextPage("cursor-1");
    await tick();
    const callsBefore = seen.length;

    bus.publish({ refs: [REF] });
    await tick();
    expect(ctrl.getSnapshot().cursor).toBeUndefined();
    expect(ctrl.getSnapshot().sort).toEqual({ field: "revenue", dir: "desc" });
    expect(seen.length).toBeGreaterThan(callsBefore);

    stop();
    const callsAfterStop = seen.length;
    bus.publish({ refs: [REF] });
    await tick();
    expect(seen.length).toBe(callsAfterStop); // no longer subscribed
  });
});

describe("createSpreadsheetRemoteController: setRef (data.bind + $state effective-ref switch)", () => {
  const REF_B = "query://sales/records?fy=2027";

  /** Like makeImmediateBinding, but also records which ref each resolve() call targeted. */
  function makeRefTrackingBinding(): {
    binding: BindingClient;
    seenRefs: string[];
    seenOpts: ResolveOptions[];
  } {
    const seenRefs: string[] = [];
    const seenOpts: ResolveOptions[] = [];
    const binding: BindingClient = {
      async resolve(refInput, opts: ResolveOptions = {}) {
        const ref = typeof refInput === "string" ? refInput : refInput.$ref;
        seenRefs.push(ref);
        seenOpts.push(opts);
        return pageData(ref, "1:src@v1");
      },
      async invokeAction() {
        return { result: null };
      },
    };
    return { binding, seenRefs, seenOpts };
  }

  it("is a no-op when the ref is unchanged (string equality, not just reference)", async () => {
    const { binding, seenRefs } = makeRefTrackingBinding();
    const ctrl = createSpreadsheetRemoteController({
      binding,
      bus: createDataInvalidationBus(),
      ref: REF,
      pageSize: undefined,
      serverSide: true,
      declaredSort: { field: "revenue", dir: "desc" },
    });
    ctrl.start();
    await tick();
    const callsAfterStart = seenRefs.length;

    let notified = false;
    ctrl.subscribe(() => {
      notified = true;
    });
    ctrl.setRef(REF); // same value, new call
    await tick();
    expect(notified).toBe(false);
    expect(seenRefs.length).toBe(callsAfterStart);
  });

  it("on change (serverSide): resets cursor, keeps interacted, and refetches under the new ref", async () => {
    const { binding, seenRefs } = makeRefTrackingBinding();
    const ctrl = createSpreadsheetRemoteController({
      binding,
      bus: createDataInvalidationBus(),
      ref: REF,
      pageSize: undefined,
      serverSide: true,
      declaredSort: undefined,
    });
    ctrl.start();
    await tick();
    ctrl.toggleSort("revenue"); // interacted=true, refetches against REF
    await tick();
    ctrl.goNextPage("cursor-1");
    await tick();
    expect(ctrl.getSnapshot().cursor).toBe("cursor-1");
    expect(seenRefs.at(-1)).toBe(REF);

    ctrl.setRef(REF_B);
    await tick();
    expect(ctrl.getSnapshot().cursor).toBeUndefined();
    // interacted is deliberately preserved across a ref switch (a user's sort choice is a display
    // preference, not tied to a specific variant of the data).
    expect(ctrl.getSnapshot().interacted).toBe(true);
    expect(ctrl.getSnapshot().sort).toEqual({ field: "revenue", dir: "desc" });
    expect(seenRefs.at(-1)).toBe(REF_B);
    expect(ctrl.getSnapshot().remote).toEqual({ status: "ready", data: pageData(REF_B, "1:src@v1") });
  });

  it("on change (non-serverSide): notifies but never calls binding.resolve", () => {
    const { binding, seenRefs } = makeRefTrackingBinding();
    const ctrl = createSpreadsheetRemoteController({
      binding,
      bus: createDataInvalidationBus(),
      ref: REF,
      pageSize: undefined,
      serverSide: false,
      declaredSort: undefined,
    });
    ctrl.start();

    let notified = false;
    ctrl.subscribe(() => {
      notified = true;
    });
    ctrl.setRef(REF_B);
    expect(notified).toBe(true);
    expect(seenRefs.length).toBe(0);
  });

  it("re-subscribes the invalidation bus to the new ref: publishing on the old ref no longer refetches, the new ref does", async () => {
    const { binding, seenRefs } = makeRefTrackingBinding();
    const bus = createDataInvalidationBus();
    const ctrl = createSpreadsheetRemoteController({
      binding,
      bus,
      ref: REF,
      pageSize: undefined,
      serverSide: true,
      declaredSort: { field: "revenue", dir: "desc" },
    });
    ctrl.start();
    await tick();
    ctrl.setRef(REF_B);
    await tick();
    const callsBeforePublish = seenRefs.length;

    bus.publish({ refs: [REF] }); // stale ref: the controller must no longer be listening on it
    await tick();
    expect(seenRefs.length).toBe(callsBeforePublish);

    bus.publish({ refs: [REF_B] });
    await tick();
    expect(seenRefs.length).toBeGreaterThan(callsBeforePublish);
    expect(seenRefs.at(-1)).toBe(REF_B);
  });

  it("an in-flight fetch for the old ref is discarded once the ref changes (last-wins by seq)", async () => {
    const { binding, seen, resolveAt } = makeDeferredBinding();
    const ctrl = createSpreadsheetRemoteController({
      binding,
      bus: createDataInvalidationBus(),
      ref: REF,
      pageSize: undefined,
      serverSide: true,
      declaredSort: { field: "revenue", dir: "desc" },
    });
    ctrl.start(); // index 0: fetch against REF, still pending
    await tick();
    expect(seen.length).toBe(1);

    ctrl.setRef(REF_B); // index 1: fetch against REF_B, still pending
    await tick();
    expect(seen.length).toBe(2);

    // The stale REF response resolves after the REF_B switch — must not overwrite the newer state.
    resolveAt(0, pageData("stale-old-ref"));
    await tick();
    expect(ctrl.getSnapshot().remote).toEqual({ status: "loading" });

    resolveAt(1, pageData("fresh-new-ref"));
    await tick();
    expect(ctrl.getSnapshot().remote).toEqual({ status: "ready", data: pageData("fresh-new-ref") });
  });
});

describe("createSpreadsheetRemoteController: error path", () => {
  it("a rejected resolve() surfaces as remote.status === 'error'", async () => {
    const { binding, rejectAt } = makeDeferredBinding();
    const ctrl = createSpreadsheetRemoteController({
      binding,
      bus: createDataInvalidationBus(),
      ref: REF,
      pageSize: undefined,
      serverSide: true,
      declaredSort: { field: "revenue", dir: "desc" },
    });
    ctrl.start();
    await tick();
    rejectAt(0, new Error("boom"));
    await tick();
    expect(ctrl.getSnapshot().remote).toEqual({ status: "error", message: "boom" });
  });
});
