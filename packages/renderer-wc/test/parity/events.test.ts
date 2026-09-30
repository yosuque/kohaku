// Shared event-behavior parity (the 4th layer + handoff): proves that governance (SPEC-EVT-002) and A1 bind
// produce "the same external observation" in both renderers. External observation = the onEvent arrival sequence /
// binding call sequence / action results / DOM appearance via visibleWhen. Both are driven by the same interactions and matched.

import type { ActionResult, BindingClient, ResolveOptions } from "@kohaku-ui/data-binding";
import { type ActionManifest, DEFAULT_MESSAGES } from "@kohaku-ui/renderer-core";
import { type JsonObject, parseSpec, type TabularData, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ActionResultArg,
  cleanupPair,
  flushReact,
  renderReact,
  renderWc,
  type SurfaceEvent,
  tick,
} from "./render-both.js";

const INTENT = { canonical: "parity.events", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L0", composedBy: "parity", cache: "hit" } as const;
const REF = "query://sales/summary";
const BIND_REF = "query://sales/records?region=japan";

const ROWS: TabularData["rows"] = [
  { region: "japan", revenue: 498200000 },
  { region: "north_america", revenue: 612800000 },
];

function tableData(rows: TabularData["rows"] = ROWS): TabularData {
  return {
    columns: [
      { key: "region", label: "Region", type: "string" },
      { key: "revenue", label: "Revenue", type: "number" },
    ],
    rows,
    dataVersion: "v1",
  };
}

function spec(partial: {
  components: unknown[];
  events?: unknown[];
  state?: Record<string, unknown>;
  refVersions?: Record<string, string>;
}): UISpec {
  return parseSpec({
    kohaku: partial.state != null ? "0.2" : "0.1",
    intent: INTENT,
    dataVersion: "v1",
    ...(partial.refVersions != null ? { refVersions: partial.refVersions } : {}),
    ...(partial.state != null ? { state: partial.state } : {}),
    components: partial.components,
    events: partial.events ?? [],
    provenance: PROVENANCE,
  });
}

/** Record of external observations. The sequences that should be identical across both renderers. */
interface Obs {
  resolves: string[];
  invokes: { action: string; payload: JsonObject }[];
  events: SurfaceEvent[];
  actionResults: { componentId: string; action: string; phase: string }[];
}

const emptyObs = (): Obs => ({ resolves: [], invokes: [], events: [], actionResults: [] });

interface Scenario {
  spec: UISpec;
  resolve?: (ref: string, opts?: ResolveOptions) => TabularData;
  invokeResult?: ActionResult;
  steps: Step[];
  /** Additional observations such as DOM appearance (visibleWhen, etc.). */
  probe?: (root: ParentNode) => unknown;
  /** Governed actions (design.md #62/#63/#64) -- the compose-issued manifest + confirm/requestApproval hooks. */
  actionManifest?: ActionManifest;
  confirm?: (args: { action: string; message?: string }) => boolean | Promise<boolean>;
  requestApproval?: (args: {
    action: string;
    payload: JsonObject;
  }) => string | undefined | Promise<string | undefined>;
}

type Step =
  | { act: "click"; sel: string }
  | { act: "fill"; sel: string; value: string }
  | { act: "select"; sel: string; value: string }
  | { act: "submit"; sel: string }
  | { act: "key"; sel: string; key: string }
  /** Waits for in-flight async work (an invoke round trip) to settle before the next step. */
  | { act: "settle" };

function recordingBinding(obs: Obs, sc: Scenario): BindingClient {
  return {
    async resolve(ref, opts) {
      const s = typeof ref === "string" ? ref : ref.$ref;
      obs.resolves.push(s);
      return sc.resolve != null ? sc.resolve(s, opts) : tableData();
    },
    async invokeAction(action, payload) {
      obs.invokes.push({ action, payload: (payload as JsonObject) ?? {} });
      return sc.invokeResult ?? { result: null };
    },
  };
}

/** React-side interaction (testing-library fireEvent handles controlled input and act). */
function applyReact(root: ParentNode, step: Step): void {
  if (step.act === "settle") return;
  const el = root.querySelector(step.sel);
  if (el == null) throw new Error(`React: element not found: ${step.sel}`);
  if (step.act === "click") fireEvent.click(el);
  else if (step.act === "submit") fireEvent.submit(el);
  else if (step.act === "key") fireEvent.keyDown(el, { key: step.key });
  else fireEvent.change(el, { target: { value: step.value } });
}

/** WC-side interaction (raw DOM. fill dispatches input, select dispatches change, submit dispatches submit natively). */
function applyWc(root: ParentNode, step: Step): void {
  if (step.act === "settle") return;
  const el = root.querySelector(step.sel) as HTMLElement | null;
  if (el == null) throw new Error(`WC: element not found: ${step.sel}`);
  if (step.act === "click") (el as HTMLElement).click();
  else if (step.act === "submit") el.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  else if (step.act === "key") {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: step.key, bubbles: true, cancelable: true }));
  } else {
    (el as HTMLInputElement).value = step.value;
    const type = step.act === "fill" ? "input" : "change";
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }
}

async function runReact(sc: Scenario): Promise<{ obs: Obs; probe: unknown }> {
  const obs = emptyObs();
  const { container } = await renderReact(
    sc.spec,
    {
      binding: () => recordingBinding(obs, sc),
      onActionResult: (a: ActionResultArg) =>
        obs.actionResults.push({ componentId: a.componentId, action: a.action, phase: a.phase }),
      ...(sc.actionManifest != null ? { actionManifest: sc.actionManifest } : {}),
      ...(sc.confirm != null ? { confirm: sc.confirm } : {}),
      ...(sc.requestApproval != null ? { requestApproval: sc.requestApproval } : {}),
    },
    (e) => obs.events.push(e),
  );
  for (const step of sc.steps) {
    applyReact(container, step);
    if (step.act === "settle") await flushReact();
  }
  await flushReact();
  return { obs, probe: sc.probe?.(container) };
}

async function runWc(sc: Scenario): Promise<{ obs: Obs; probe: unknown }> {
  const obs = emptyObs();
  const { surface } = await renderWc(
    sc.spec,
    {
      binding: () => recordingBinding(obs, sc),
      onActionResult: (a: ActionResultArg) =>
        obs.actionResults.push({ componentId: a.componentId, action: a.action, phase: a.phase }),
      ...(sc.actionManifest != null ? { actionManifest: sc.actionManifest } : {}),
      ...(sc.confirm != null ? { confirm: sc.confirm } : {}),
      ...(sc.requestApproval != null ? { requestApproval: sc.requestApproval } : {}),
    },
    (e) => obs.events.push(e),
  );
  const shadow = surface.shadowRoot!;
  for (const step of sc.steps) {
    applyWc(shadow, step);
    if (step.act === "settle") await tick();
  }
  await tick();
  return { obs, probe: sc.probe?.(shadow) };
}

async function bothObserve(
  sc: Scenario,
): Promise<{ react: { obs: Obs; probe: unknown }; wc: { obs: Obs; probe: unknown } }> {
  const react = await runReact(sc);
  const wc = await runWc(sc);
  return { react, wc };
}

describe("event behavior parity (control + A1 have identical external observation across both renderers)", () => {
  afterEach(() => cleanupPair());

  it("rowClick forwards with a $row-resolved payload and both match", async () => {
    const sc: Scenario = {
      spec: spec({
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["table1"] },
          { id: "table1", type: "presentSpreadsheet", props: {}, data: { $ref: REF } },
        ],
        refVersions: { [REF]: "v1" },
        events: [{ on: "table1.rowClick", emit: "intent.patch", payload: { drilldown: "$row.region" } }],
      }),
      steps: [{ act: "click", sel: '[data-kohaku="table1"] tbody tr' }],
    };
    const { react, wc } = await bothObserve(sc);
    const expected = [
      { componentId: "table1", on: "table1.rowClick", emit: "intent.patch", payload: { drilldown: "japan" } },
    ];
    expect(react.obs.events).toEqual(expected);
    expect(wc.obs.events).toEqual(react.obs.events);
  });

  it("sortChange fires an identical { value: { field, dir } } payload in both on a user sort toggle", async () => {
    const sc: Scenario = {
      spec: spec({
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["table1"] },
          { id: "table1", type: "presentSpreadsheet", props: {}, data: { $ref: REF } },
        ],
        refVersions: { [REF]: "v1" },
        events: [{ on: "table1.sortChange", emit: "intent.patch", payload: { value: "$value" } }],
      }),
      steps: [{ act: "click", sel: '[data-kohaku="table1"] th:nth-child(2) button' }],
    };
    const { react, wc } = await bothObserve(sc);
    const expected = [
      {
        componentId: "table1",
        on: "table1.sortChange",
        emit: "intent.patch",
        payload: { value: { field: "revenue", dir: "desc" } },
      },
    ];
    expect(react.obs.events).toEqual(expected);
    expect(wc.obs.events).toEqual(react.obs.events);
  });

  it("undeclared events are dropped, only declared ones forward (SPEC-EVT-002) and both match", async () => {
    const sc: Scenario = {
      spec: spec({
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["b1", "b2"] },
          { id: "b1", type: "action.button", props: { label: "undeclared" } },
          { id: "b2", type: "action.button", props: { label: "declared" } },
        ],
        events: [{ on: "b2.press", emit: "intent.replace", payload: { kind: "go" } }],
      }),
      steps: [
        { act: "click", sel: '[data-kohaku="b1"]' },
        { act: "click", sel: '[data-kohaku="b2"]' },
      ],
    };
    const { react, wc } = await bothObserve(sc);
    // b1 is dropped, only b2 is forwarded.
    expect(react.obs.events).toEqual([
      { componentId: "b2", on: "b2.press", emit: "intent.replace", payload: { kind: "go" } },
    ]);
    expect(wc.obs.events).toEqual(react.obs.events);
  });

  it("state.set → visibleWhen DOM appearance matches in both", async () => {
    const sc: Scenario = {
      spec: spec({
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
      }),
      steps: [{ act: "select", sel: '[data-kohaku="sel"]', value: "show" }],
      probe: (root) => root.querySelector('[data-kohaku="panel"]')?.textContent ?? null,
    };
    const { react, wc } = await bothObserve(sc);
    // No undeclared events and no onEvent arrivals (state.set is self-contained within the Renderer).
    expect(react.obs.events).toEqual([]);
    expect(wc.obs.events).toEqual([]);
    // Selecting "show" makes the panel appear (identical for both).
    expect(react.probe).toBe("secret");
    expect(wc.probe).toBe(react.probe);
  });

  it("control.select → state.set → A1 bind re-resolution (effective ref) matches in both", async () => {
    const sc: Scenario = {
      spec: spec({
        state: { region: "japan" },
        refVersions: { [BIND_REF]: "v1" },
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["sel", "tbl"] },
          { id: "sel", type: "control.select", props: { options: ["japan", "us"], value: "japan" } },
          {
            id: "tbl",
            type: "presentSpreadsheet",
            props: {},
            data: { $ref: BIND_REF, bind: { region: { $state: "region", values: ["japan", "us"] } } },
          },
        ],
        events: [{ on: "sel.change", emit: "state.set", payload: { key: "region", value: "$value" } }],
      }),
      resolve: (ref) => (ref.includes("region=us") ? tableData([{ region: "us", revenue: 1 }]) : tableData()),
      steps: [{ act: "select", sel: '[data-kohaku="sel"]', value: "us" }],
    };
    const { react, wc } = await bothObserve(sc);
    // Two resolutions: initial japan → us after the change (no compose fired, only the effective ref is swapped).
    expect(react.obs.resolves).toEqual([BIND_REF, "query://sales/records?region=us"]);
    expect(wc.obs.resolves).toEqual(react.obs.resolves);
    expect(wc.obs.events).toEqual(react.obs.events); // neither forwards (self-contained within state.set)
  });

  it("write loop: submit → invokeAction → invalidates → distant table re-resolves (both match)", async () => {
    const sc: Scenario = {
      spec: spec({
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
      }),
      invokeResult: { result: { ok: true }, invalidates: [REF], refVersions: { [REF]: "v2" } },
      steps: [
        { act: "fill", sel: "#f1-note", value: "Check North America" },
        { act: "submit", sel: '[data-kohaku="f1"]' },
      ],
    };
    const { react, wc } = await bothObserve(sc);
    // invoke happens once with the $value.note-resolved payload.
    expect(react.obs.invokes).toEqual([{ action: "annotate", payload: { note: "Check North America" } }]);
    expect(wc.obs.invokes).toEqual(react.obs.invokes);
    // The table resolves twice: initial + re-resolution after invalidation (in-place re-resolution of the distant table).
    expect(react.obs.resolves).toEqual([REF, REF]);
    expect(wc.obs.resolves).toEqual(react.obs.resolves);
    // The action completion notification is succeeded.
    expect(react.obs.actionResults).toEqual([{ componentId: "f1", action: "annotate", phase: "succeeded" }]);
    expect(wc.obs.actionResults).toEqual(react.obs.actionResults);
    // Since submit is action.invoke, it does not flow to onEvent (governance).
    expect(react.obs.events).toEqual([]);
    expect(wc.obs.events).toEqual([]);
  });

  it("governed actions: a locally-invalid payload never invokes, identically in both (design.md #62)", async () => {
    const sc: Scenario = {
      spec: spec({
        components: [{ id: "root", type: "action.button", props: { action: "annotate", label: "Go" } }],
        events: [{ on: "root.press", emit: "action.invoke", payload: { note: "way too long" } }],
      }),
      actionManifest: {
        annotate: {
          tier: "auto",
          paramsSchema: { type: "object", properties: { note: { type: "string", maxLength: 3 } } },
        },
      },
      steps: [{ act: "click", sel: '[data-kohaku="root"]' }],
    };
    const { react, wc } = await bothObserve(sc);
    expect(react.obs.invokes).toEqual([]);
    expect(wc.obs.invokes).toEqual(react.obs.invokes);
  });

  // The visible outcome of a governed action that did not commit: every alert / status region, in DOM order.
  const notices = (root: ParentNode): string[] =>
    [...root.querySelectorAll('[role="alert"], [role="status"]')].map(
      (e) => `${e.getAttribute("role")}:${e.textContent}`,
    );

  it("governed actions: an invalid payload on action.button is announced as an alert in both (design.md #62)", async () => {
    const sc: Scenario = {
      spec: spec({
        components: [{ id: "root", type: "action.button", props: { action: "annotate", label: "Go" } }],
        events: [{ on: "root.press", emit: "action.invoke", payload: { note: "way too long" } }],
      }),
      actionManifest: {
        annotate: {
          tier: "auto",
          paramsSchema: { type: "object", properties: { note: { type: "string", maxLength: 3 } } },
        },
      },
      steps: [{ act: "click", sel: '[data-kohaku="root"]' }],
      probe: notices,
    };
    const { react, wc } = await bothObserve(sc);
    expect(react.probe).toEqual([`alert:${DEFAULT_MESSAGES.actionInvalid(1)}`]);
    expect(wc.probe).toEqual(react.probe);
  });

  it("governed actions: a declined confirmation on action.button is announced as a status in both (design.md #63)", async () => {
    const sc: Scenario = {
      spec: spec({
        components: [{ id: "root", type: "action.button", props: { action: "annotate", label: "Go" } }],
        events: [{ on: "root.press", emit: "action.invoke", payload: { note: "hi" } }],
      }),
      actionManifest: { annotate: { tier: "confirm" } },
      confirm: async () => false,
      steps: [{ act: "click", sel: '[data-kohaku="root"]' }],
      probe: notices,
    };
    const { react, wc } = await bothObserve(sc);
    expect(react.obs.invokes).toEqual([]);
    expect(react.probe).toEqual([`status:${DEFAULT_MESSAGES.actionAwaiting("confirm")}`]);
    expect(wc.probe).toEqual(react.probe);
  });

  it("governed actions: a form's invalid submit replaces the previous submit's message in both", async () => {
    const sc: Scenario = {
      spec: spec({
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["f1"] },
          {
            id: "f1",
            type: "presentForm",
            props: { action: "annotate", successMessage: "Saved", fields: [{ name: "note", type: "text" }] },
          },
        ],
        events: [{ on: "f1.submit", emit: "action.invoke", payload: { note: "$value.note" } }],
      }),
      actionManifest: {
        annotate: {
          tier: "auto",
          paramsSchema: { type: "object", properties: { note: { type: "string", maxLength: 5 } } },
        },
      },
      steps: [
        { act: "fill", sel: "#f1-note", value: "ok" },
        { act: "submit", sel: '[data-kohaku="f1"]' },
        { act: "settle" },
        { act: "fill", sel: "#f1-note", value: "way too long" },
        { act: "submit", sel: '[data-kohaku="f1"]' },
        { act: "settle" },
      ],
      probe: notices,
    };
    const { react, wc } = await bothObserve(sc);
    expect(react.obs.invokes).toEqual([{ action: "annotate", payload: { note: "ok" } }]);
    expect(wc.obs.invokes).toEqual(react.obs.invokes);
    // Only the rejection remains: "Saved" from the first submit must not linger next to it.
    expect(react.probe).toEqual([`alert:${DEFAULT_MESSAGES.actionInvalid(1)}`]);
    expect(wc.probe).toEqual(react.probe);
  });

  it("governed actions: tier confirm defaults to globalThis.confirm identically in both (design.md #62/#63)", async () => {
    const sc: Scenario = {
      spec: spec({
        components: [{ id: "root", type: "action.button", props: { action: "annotate", label: "Go" } }],
        events: [{ on: "root.press", emit: "action.invoke", payload: { note: "hi" } }],
      }),
      actionManifest: { annotate: { tier: "confirm" } },
      steps: [{ act: "click", sel: '[data-kohaku="root"]' }],
    };
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    try {
      const { react, wc } = await bothObserve(sc);
      expect(react.obs.invokes).toEqual([{ action: "annotate", payload: { note: "hi" } }]);
      expect(wc.obs.invokes).toEqual(react.obs.invokes);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("governed actions: tier approve invokes with the requestApproval hook's token, identically in both (design.md #63)", async () => {
    const sc: Scenario = {
      spec: spec({
        components: [{ id: "root", type: "action.button", props: { action: "publish", label: "Go" } }],
        events: [{ on: "root.press", emit: "action.invoke", payload: {} }],
      }),
      actionManifest: { publish: { tier: "approve" } },
      requestApproval: async () => "kohaku-approval.v1.tok",
      steps: [{ act: "click", sel: '[data-kohaku="root"]' }],
    };
    const { react, wc } = await bothObserve(sc);
    expect(react.obs.invokes).toEqual([{ action: "publish", payload: {} }]);
    expect(wc.obs.invokes).toEqual(react.obs.invokes);
  });

  it("cellEdit (intent.*): forwards an identical { value: { column, value, previousValue, rowIndex } } payload in both", async () => {
    const sc: Scenario = {
      spec: spec({
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["table1"] },
          { id: "table1", type: "presentSpreadsheet", props: { editable: true }, data: { $ref: REF } },
        ],
        refVersions: { [REF]: "v1" },
        events: [{ on: "table1.cellEdit", emit: "intent.patch", payload: { value: "$value" } }],
      }),
      steps: [
        { act: "click", sel: '[data-kohaku="table1"] tbody button[aria-label="Edit Revenue"]' },
        { act: "fill", sel: '[data-kohaku="table1"] tbody input[aria-label="Edit Revenue"]', value: "999" },
        { act: "key", sel: '[data-kohaku="table1"] tbody input[aria-label="Edit Revenue"]', key: "Enter" },
      ],
    };
    const { react, wc } = await bothObserve(sc);
    const expected = [
      {
        componentId: "table1",
        on: "table1.cellEdit",
        emit: "intent.patch",
        payload: { value: { column: "revenue", value: 999, previousValue: 498200000, rowIndex: 0 } },
      },
    ];
    expect(react.obs.events).toEqual(expected);
    expect(wc.obs.events).toEqual(react.obs.events);
  });

  it("cellEdit -> action.invoke: writes straight through, invokes / actionResults / resolves match in both", async () => {
    const sc: Scenario = {
      spec: spec({
        refVersions: { [REF]: "v1" },
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["table1"] },
          { id: "table1", type: "presentSpreadsheet", props: { editable: true }, data: { $ref: REF } },
        ],
        events: [
          {
            on: "table1.cellEdit",
            emit: "action.invoke",
            payload: { action: "updateCell", value: "$value.value" },
          },
        ],
      }),
      invokeResult: { result: { ok: true }, invalidates: [REF], refVersions: { [REF]: "v2" } },
      steps: [
        { act: "click", sel: '[data-kohaku="table1"] tbody button[aria-label="Edit Revenue"]' },
        { act: "fill", sel: '[data-kohaku="table1"] tbody input[aria-label="Edit Revenue"]', value: "999" },
        { act: "key", sel: '[data-kohaku="table1"] tbody input[aria-label="Edit Revenue"]', key: "Enter" },
      ],
    };
    const { react, wc } = await bothObserve(sc);
    expect(react.obs.invokes).toEqual([
      { action: "updateCell", payload: { action: "updateCell", value: 999 } },
    ]);
    expect(wc.obs.invokes).toEqual(react.obs.invokes);
    // The table resolves twice: initial + re-resolution after invalidation.
    expect(react.obs.resolves).toEqual([REF, REF]);
    expect(wc.obs.resolves).toEqual(react.obs.resolves);
    expect(react.obs.actionResults).toEqual([
      { componentId: "table1", action: "updateCell", phase: "succeeded" },
    ]);
    expect(wc.obs.actionResults).toEqual(react.obs.actionResults);
    // Since cellEdit is action.invoke here, it does not flow to onEvent (governance).
    expect(react.obs.events).toEqual([]);
    expect(wc.obs.events).toEqual([]);
  });

  describe("cellEdit -> governed action.invoke", () => {
    const EDIT_STEPS: Step[] = [
      { act: "click", sel: '[data-kohaku="table1"] tbody button[aria-label="Edit Revenue"]' },
      { act: "fill", sel: '[data-kohaku="table1"] tbody input[aria-label="Edit Revenue"]', value: "999" },
      { act: "key", sel: '[data-kohaku="table1"] tbody input[aria-label="Edit Revenue"]', key: "Enter" },
    ];
    const cellSpec = () =>
      spec({
        refVersions: { [REF]: "v1" },
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["table1"] },
          { id: "table1", type: "presentSpreadsheet", props: { editable: true }, data: { $ref: REF } },
        ],
        events: [
          {
            on: "table1.cellEdit",
            emit: "action.invoke",
            payload: { action: "updateCell", value: "$value.value" },
          },
        ],
      });
    /** The table body's text plus whether any cell input is still open and marked invalid. */
    const tableProbe = (root: ParentNode) => ({
      body: root.querySelector('[data-kohaku="table1"] tbody')?.textContent ?? "",
      invalidInput: root.querySelector('[data-kohaku="table1"] tbody input[aria-invalid="true"]') != null,
    });

    it("a payload the manifest rejects is caught in edit mode, before any commit or invoke, in both", async () => {
      const sc: Scenario = {
        spec: cellSpec(),
        actionManifest: {
          updateCell: {
            tier: "auto",
            paramsSchema: { type: "object", properties: { value: { type: "number", maximum: 100 } } },
          },
        },
        steps: EDIT_STEPS,
        probe: tableProbe,
      };
      const { react, wc } = await bothObserve(sc);
      expect(react.obs.invokes).toEqual([]);
      expect(wc.obs.invokes).toEqual([]);
      expect(react.probe).toMatchObject({ invalidInput: true });
      expect(wc.probe).toEqual(react.probe);
    });

    it("a declined confirmation puts the server value back in the cell, in both", async () => {
      const sc: Scenario = {
        spec: cellSpec(),
        actionManifest: { updateCell: { tier: "confirm" } },
        confirm: async () => false,
        steps: [...EDIT_STEPS, { act: "settle" }],
        probe: tableProbe,
      };
      const { react, wc } = await bothObserve(sc);
      expect(react.obs.invokes).toEqual([]);
      expect(wc.obs.invokes).toEqual([]);
      expect((react.probe as { body: string }).body).not.toContain("999");
      expect((react.probe as { body: string }).body).toContain("498,200,000");
      expect(wc.probe).toEqual(react.probe);
    });
  });
});
