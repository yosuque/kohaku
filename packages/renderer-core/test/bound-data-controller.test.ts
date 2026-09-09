import type { BindingClient, ResolveOptions } from "@kohaku-ui/data-binding";
import { BindingError } from "@kohaku-ui/data-binding";
import type { ComponentNode, TabularData, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  type BoundData,
  createBoundDataController,
  createDataInvalidationBus,
  createSpecStateStore,
} from "../src/index.js";

const REF = "query://ledger/sales?region=japan";
const MSG = { bindingMissing: "no-binding", dataStale: "stale!" };

const DATA: TabularData = {
  columns: [{ key: "region", label: "Region", type: "string" }],
  rows: [{ region: "japan" }],
  dataVersion: "v1",
};

// renderer-core does not depend on DOM/node types (tsconfig types:[]). The test's
// microtask flush also does not rely on timers such as setTimeout, and drains the
// .then chain by spinning Promise.resolve() for several turns.
const tick = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function refNode(ref: string, bind?: Record<string, unknown>): ComponentNode {
  return {
    id: "t",
    type: "presentSpreadsheet",
    props: {},
    data: bind != null ? { $ref: ref, bind } : { $ref: ref },
  } as unknown as ComponentNode;
}
function noDataNode(): ComponentNode {
  return { id: "t", type: "presentMarkdown", props: {} } as unknown as ComponentNode;
}
function makeSpec(opts: { dataVersion?: string; refVersions?: Record<string, string> }): UISpec {
  return {
    intent: { hash: "h" },
    events: [],
    dataVersion: opts.dataVersion,
    refVersions: opts.refVersions,
  } as unknown as UISpec;
}

describe("BoundDataController (basic states)", () => {
  it("idle when there is no data", () => {
    const store = createSpecStateStore("h", {});
    const ctrl = createBoundDataController({
      binding: undefined,
      bus: createDataInvalidationBus(),
      state: store,
      messages: MSG,
    });
    const states: BoundData[] = [];
    const detach = ctrl.attach(noDataNode(), makeSpec({}), (s) => states.push(s));
    expect(states).toEqual([{ status: "idle" }]);
    detach();
  });

  it("bindingMissing error when data exists but binding is unset", () => {
    const store = createSpecStateStore("h", {});
    const ctrl = createBoundDataController({
      binding: undefined,
      bus: createDataInvalidationBus(),
      state: store,
      messages: MSG,
    });
    const states: BoundData[] = [];
    ctrl.attach(refNode(REF), makeSpec({ dataVersion: "v1" }), (s) => states.push(s));
    expect(states).toEqual([{ status: "error", message: "no-binding" }]);
  });

  it("loading → ready on successful resolution (with dataVersion)", async () => {
    const binding: BindingClient = {
      async resolve() {
        return DATA;
      },
      async invokeAction() {
        return { result: null };
      },
    };
    const store = createSpecStateStore("h", {});
    const ctrl = createBoundDataController({
      binding,
      bus: createDataInvalidationBus(),
      state: store,
      messages: MSG,
    });
    const states: BoundData[] = [];
    ctrl.attach(refNode(REF), makeSpec({ dataVersion: "v1" }), (s) => states.push(s));
    expect(states[0]).toEqual({ status: "loading" });
    await tick();
    expect(states.at(-1)).toEqual({ status: "ready", data: DATA, dataVersion: "v1" });
  });

  it("STALE_VERSION surfaces as stale", async () => {
    const binding: BindingClient = {
      async resolve() {
        throw new BindingError("STALE_VERSION", "stale version", { status: 409 });
      },
      async invokeAction() {
        return { result: null };
      },
    };
    const store = createSpecStateStore("h", {});
    const ctrl = createBoundDataController({
      binding,
      bus: createDataInvalidationBus(),
      state: store,
      messages: MSG,
    });
    const states: BoundData[] = [];
    ctrl.attach(refNode(REF), makeSpec({ dataVersion: "v1" }), (s) => states.push(s));
    await tick();
    expect(states.at(-1)).toEqual({ status: "stale", message: "stale!" });
  });
});

describe("BoundDataController (freshness matching)", () => {
  it("initial variant prefers refVersions[ref], otherwise passes dataVersion as expectedDataVersion", async () => {
    const seen: (string | undefined)[] = [];
    const binding: BindingClient = {
      async resolve(_ref, opts?: ResolveOptions) {
        seen.push(opts?.expectedDataVersion);
        return DATA;
      },
      async invokeAction() {
        return { result: null };
      },
    };
    const store = createSpecStateStore("h", {});
    const ctrl = createBoundDataController({
      binding,
      bus: createDataInvalidationBus(),
      state: store,
      messages: MSG,
    });
    // refVersions takes priority
    ctrl.attach(
      refNode(REF),
      makeSpec({ dataVersion: "multi:zz", refVersions: { [REF]: "src@v1" } }),
      () => {},
    );
    await tick();
    expect(seen).toEqual(["src@v1"]);
  });

  it("A1: skips matching when $state switches to a different variant (expectedDataVersion unspecified)", async () => {
    const seen: (string | undefined)[] = [];
    const binding: BindingClient = {
      async resolve(_ref, opts?: ResolveOptions) {
        seen.push(opts?.expectedDataVersion);
        return DATA;
      },
      async invokeAction() {
        return { result: null };
      },
    };
    const store = createSpecStateStore("h", {});
    const ctrl = createBoundDataController({
      binding,
      bus: createDataInvalidationBus(),
      state: store,
      messages: MSG,
    });
    const node = refNode(REF, { region: { $state: "region", values: ["japan", "us"] } });
    ctrl.attach(node, makeSpec({ dataVersion: "v1" }), () => {});
    await tick();
    // the initial variant (effective ref === the raw $ref) matches against dataVersion
    expect(seen).toEqual(["v1"]);

    // changing $state makes the effective ref a different variant, skipping matching
    store.set("region", "us");
    await tick();
    expect(seen).toEqual(["v1", undefined]);
  });

  it("re-resolves the main path when a $state change alters the effective ref", async () => {
    const refs: string[] = [];
    const binding: BindingClient = {
      async resolve(ref) {
        refs.push(typeof ref === "string" ? ref : ref.$ref);
        return DATA;
      },
      async invokeAction() {
        return { result: null };
      },
    };
    const store = createSpecStateStore("h", {});
    const ctrl = createBoundDataController({
      binding,
      bus: createDataInvalidationBus(),
      state: store,
      messages: MSG,
    });
    const node = refNode(REF, { region: { $state: "region", values: ["japan", "us"] } });
    ctrl.attach(node, makeSpec({ dataVersion: "v1" }), () => {});
    await tick();
    store.set("region", "us");
    await tick();
    expect(refs).toEqual(["query://ledger/sales?region=japan", "query://ledger/sales?region=us"]);
  });
});

describe("BoundDataController (attach options.enabled)", () => {
  it("enabled:false reports idle synchronously and never calls binding.resolve", async () => {
    const seen: (string | undefined)[] = [];
    const binding: BindingClient = {
      async resolve(_ref, opts?: ResolveOptions) {
        seen.push(opts?.expectedDataVersion);
        return DATA;
      },
      async invokeAction() {
        return { result: null };
      },
    };
    const store = createSpecStateStore("h", {});
    const ctrl = createBoundDataController({
      binding,
      bus: createDataInvalidationBus(),
      state: store,
      messages: MSG,
    });
    const states: BoundData[] = [];
    const detach = ctrl.attach(refNode(REF), makeSpec({ dataVersion: "v1" }), (s) => states.push(s), {
      enabled: false,
    });
    expect(states).toEqual([{ status: "idle" }]);
    await tick();
    // No resolution, no $state subscription, no invalidation subscription.
    expect(seen).toEqual([]);
    store.set("x", 1);
    await tick();
    expect(states).toEqual([{ status: "idle" }]);
    detach();
  });
});

describe("BoundDataController (last-write-wins, invalidation)", () => {
  it("a slow response from the earlier (main path) does not overwrite the later (bus re-resolution)", async () => {
    const resolvers: ((d: TabularData) => void)[] = [];
    const binding: BindingClient = {
      resolve() {
        return new Promise<TabularData>((res) => resolvers.push(res));
      },
      async invokeAction() {
        return { result: null };
      },
    };
    const bus = createDataInvalidationBus();
    const store = createSpecStateStore("h", {});
    const ctrl = createBoundDataController({ binding, bus, state: store, messages: MSG });
    const states: BoundData[] = [];
    ctrl.attach(refNode(REF), makeSpec({ dataVersion: "v1" }), (s) => states.push(s));

    // the main path (first = seq1) is pending
    expect(resolvers.length).toBe(1);
    // an invalidation publish makes the bus re-resolution (later = seq2) pending
    bus.publish({ refs: [REF] });
    expect(resolvers.length).toBe(2);

    // settle the later one first → the display is fresh
    resolvers[1]!({ columns: DATA.columns, rows: [{ region: "fresh" }], dataVersion: "v2" });
    await tick();
    expect(states.at(-1)).toMatchObject({ status: "ready", data: { rows: [{ region: "fresh" }] } });

    // settle the earlier one afterward → it is stale, so it does not overwrite
    resolvers[0]!({ columns: DATA.columns, rows: [{ region: "stale" }], dataVersion: "v1" });
    await tick();
    expect(states.at(-1)).toMatchObject({ status: "ready", data: { rows: [{ region: "fresh" }] } });
  });

  it("uses the invalidation event's refVersions as the re-resolution matching target (skips matching if unknown)", async () => {
    const seen: (string | undefined)[] = [];
    const binding: BindingClient = {
      async resolve(_ref, opts?: ResolveOptions) {
        seen.push(opts?.expectedDataVersion);
        return DATA;
      },
      async invokeAction() {
        return { result: null };
      },
    };
    const bus = createDataInvalidationBus();
    const store = createSpecStateStore("h", {});
    const ctrl = createBoundDataController({ binding, bus, state: store, messages: MSG });
    ctrl.attach(refNode(REF), makeSpec({ dataVersion: "v1" }), () => {});
    await tick();
    expect(seen).toEqual(["v1"]); // initial main path

    bus.publish({ refs: [REF], refVersions: { [REF]: "v2" } });
    await tick();
    expect(seen).toEqual(["v1", "v2"]); // match against the event's version

    bus.publish({ refs: [REF] }); // no refVersions → skip matching
    await tick();
    expect(seen).toEqual(["v1", "v2", undefined]);
  });

  it("does not re-resolve on $state change or invalidation after detach", async () => {
    const binding: BindingClient = {
      async resolve() {
        return DATA;
      },
      async invokeAction() {
        return { result: null };
      },
    };
    const bus = createDataInvalidationBus();
    const store = createSpecStateStore("h", {});
    const ctrl = createBoundDataController({ binding, bus, state: store, messages: MSG });
    const states: BoundData[] = [];
    const detach = ctrl.attach(refNode(REF), makeSpec({ dataVersion: "v1" }), (s) => states.push(s));
    await tick();
    const count = states.length;
    detach();
    bus.publish({ refs: [REF] });
    store.set("x", 1);
    await tick();
    expect(states.length).toBe(count);
  });
});
