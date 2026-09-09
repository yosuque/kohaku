import type {
  CanonicalIntent,
  ComponentNode,
  EventBinding,
  JsonObject,
  JsonValue,
  Provenance,
} from "@kohaku-ui/spec-core";

/**
 * Types for the A2UI-compatible profile skeleton ([Draft], out of conformance scope, no external consumers).
 * **Fully follows the wire shape of the A2UI v0.9.1 specification** by default (the provisional
 * beginRendering/componentUpdate forms are dropped), with an **opt-in `target: "v1.0"`** ({@link A2uiTarget})
 * following the A2UI v1.0 RC (still Q4 2026-stabilization-targeted per a2ui.org; not yet stable).
 *
 * Facts confirmed by research against the a2ui-project/a2ui v0.9.1 spec, its basic catalog, and the reference SDK schemas:
 * - The envelope is `{ version, <messageKey> }` with exactly one message key. The reference SDK's
 *   `StrictBaseModel` (`extra="forbid"`) makes both the envelope and the message body **reject unknown keys**.
 * - A component is a **flat shape** `{ id, component, ...props inlined, children | child, action? }`.
 *   The basic catalog imposes `unevaluatedProperties: false` on every component, so **a component cannot carry
 *   unknown keys (x-kohaku-*, etc.) either**.
 *
 * Consequence (where to put x-kohaku-*): there is no room to carry kohaku-specific information inside the A2UI wire
 * — not in the envelope, the message body, or the component. This profile therefore
 * **keeps A2UI messages strictly wire-compliant and losslessly offloads kohaku-specific information into a separate
 * sidecar ({@link KohakuSidecar})** (the original type / data.$ref / bind /
 * visibleWhen / intent / provenance / dataVersion / refVersions / state / events /
 * baseIntentHash are preserved by the sidecar). The round-trip (client action → GuiAction) needs no sidecar
 * because it is encoded in the event name `<componentId>.<eventName>`.
 *
 * v1.0 RC facts (target of `target: "v1.0"`) were confirmed the same way: by fetching
 * https://a2ui.org/specification/v1.0-a2ui/ and the raw JSON Schema files at
 * `a2ui-project/a2ui@main:specification/v1_0/json/{agent_to_renderer,common_types,renderer_to_agent}.json`
 * on GitHub (see the section comments below for what each fact backs). **Default output (`target` omitted
 * or `"v0.9.1"`) is unaffected and remains byte-identical** — verified by a golden test
 * (`test/a2ui.test.ts`, "target v0.9.1 (default) output is byte-identical to pre-v1.0 output").
 */

/** Emitted A2UI spec version. Every example in the v0.9.1 protocol uses `"v0.9.1"` (the version this profile follows). */
// Note: the reference SDK's `SPEC_VERSION` constant is the major.minor `"v0.9"`. If the difference causes interop
// problems, drop this to `"v0.9"` or make it switchable via opts (currently v0.9.1, matching the protocol doc we follow).
export const A2UI_VERSION = "v0.9.1" as const;

/**
 * Emitted A2UI spec version when `target: "v1.0"` is requested (the A2UI v1.0 RC; not yet stable,
 * target Q4 2026 per a2ui.org). Every example in the v1.0 RC's JSON Schema (`agent_to_renderer.json`)
 * fixes `version` to the const `"v1.0"`.
 */
export const A2UI_V1_VERSION = "v1.0" as const;

/** `toA2ui` / `patchToA2ui` output target. Defaults to `"v0.9.1"` everywhere (byte-identical to pre-v1.0 output). */
export type A2uiTarget = "v0.9.1" | "v1.0";

// ─────────────────────────────────────────────────────────────────────────────
// Values (literal / binding / function). Correspond to v0.9.1's DynamicString/Number/Value.
// ─────────────────────────────────────────────────────────────────────────────

/** Data binding. Points to a location within the data model using an RFC 6901 JSON Pointer. */
export interface A2uiBinding {
  path: string;
}

/** Client-side function call (shared shape for validation checks / action.functionCall / value computation). */
export interface A2uiFunctionCall {
  call: string;
  args: Record<string, A2uiValue>;
  /** Return-type hint (used by some v0.9.1 functions). */
  returnType?: string;
}

/** The three forms of a property value: literal (raw JSON) / binding `{path}` / function `{call,args}`. */
export type A2uiValue = JsonValue | A2uiBinding | A2uiFunctionCall;

// ─────────────────────────────────────────────────────────────────────────────
// Components (flat shape + id references).
// ─────────────────────────────────────────────────────────────────────────────

/** Child representation: an array of ids (static), or a template `{path, componentId}` (data-driven iteration). */
export type A2uiChildren = string[] | { path: string; componentId: string };

/** Event declaration on a component. On firing, the client emits a client→server action. */
export interface A2uiEvent {
  name: string;
  /** key→value resolved at emit time. Values are literal / binding / function (resolved to concrete values once emitted). */
  context: Record<string, A2uiValue>;
}

/**
 * An action on a component. Either an `event` that notifies the server on user interaction, or a
 * `functionCall` handled entirely on the client (e.g. openUrl).
 */
export type A2uiComponentAction = { event: A2uiEvent } | { functionCall: A2uiFunctionCall };

/**
 * An A2UI adjacency-list component (flat). Apart from the known structural keys, catalog props are **inlined**
 * (Text.text / variant / justify / align / weight, etc.). The index signature's value range includes JsonValue and
 * also covers the structural keys (children/child/action).
 */
export interface A2uiComponent {
  id: string;
  component: string;
  /** Multi-child container (Row / Column / List, etc.). */
  children?: A2uiChildren;
  /** Single-child container (Card / Button, etc.; research confirmed the singular `child` form exists). */
  child?: string;
  /** Event / local function. */
  action?: A2uiComponentAction;
  /** Everything else: catalog props inlined. */
  [prop: string]: JsonValue | A2uiChildren | A2uiComponentAction | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server→client messages (v0.9.1).
// ─────────────────────────────────────────────────────────────────────────────

/** Create a new surface. surfaceId and catalogId are fixed after creation. */
export interface A2uiCreateSurface {
  surfaceId: string;
  catalogId: string;
  /** Theme (arbitrary JSON conforming to the catalog's theme schema). Usually omitted since kohaku has no theme. */
  theme?: JsonObject;
  /** When true, the client includes the full data model in subsequent A2A messages. */
  sendDataModel?: boolean;
}

/** Component upsert (replace/add on id match). A2UI has no component-delete message (confirmed by research). */
export interface A2uiUpdateComponents {
  surfaceId: string;
  components: A2uiComponent[];
}

/** Data model update. path is RFC 6901 (defaults to "/"). Omitting value deletes that key. */
export interface A2uiUpdateDataModel {
  surfaceId: string;
  path?: string;
  value?: JsonValue;
}

/** Delete a surface (discards all components / data). */
export interface A2uiDeleteSurface {
  surfaceId: string;
}

/**
 * A2UI envelope (v0.9.1). `version` + exactly one message key.
 * In the v1.0 RC, `callRendererFunction` / `agentFunctionResponse` are added to the server→client direction
 * (see {@link A2uiEnvelopeV1}), and `createSurface` gains `components` / `dataModel` bundling while dropping `theme`.
 */
export type A2uiEnvelope =
  | { version: string; createSurface: A2uiCreateSurface }
  | { version: string; updateComponents: A2uiUpdateComponents }
  | { version: string; updateDataModel: A2uiUpdateDataModel }
  | { version: string; deleteSurface: A2uiDeleteSurface };

// ─────────────────────────────────────────────────────────────────────────────
// Server→client messages (v1.0 RC additions/differences).
//
// Ground truth confirmed by fetching the a2ui-project/a2ui v1.0 JSON Schemas directly
// (`specification/v1_0/json/agent_to_renderer.json`, `common_types.json`, `renderer_to_agent.json`
// on the `a2ui-project/a2ui` GitHub repo, and https://a2ui.org/specification/v1.0-a2ui/):
// - `createSurface` gains optional `components` (a `ComponentsList`, `minItems: 1`) and `dataModel`
//   (a plain JSON object), letting a surface be fully constructed in one message. `theme` does not
//   appear in the v1.0 `createSurface` properties (removed per the RC's "Decoupled Branding" change).
// - Two new server→client message kinds: `callRendererFunction` ({functionCallId, callFunction} where
//   callFunction.catalogId is REQUIRED) and `agentFunctionResponse` (a `FunctionResponse`:
//   {functionCallId, value XOR error}).
// - Component objects gain an optional per-component `catalogId` (`ComponentCommon`), overriding the
//   surface-level default. Not emitted by this profile (kohaku has one catalog per surface); the field
//   is omitted from {@link A2uiComponent} to keep the v0.9.1 wire shape shared and byte-identical.
// ─────────────────────────────────────────────────────────────────────────────

/** v1.0 `createSurface`: components / data model bundled directly, no `theme`. */
export interface A2uiCreateSurfaceV1 {
  surfaceId: string;
  catalogId: string;
  /** Bundled component list (schema requires `minItems: 1`; kohaku always includes the full tree here). */
  components?: A2uiComponent[];
  /** Bundled initial data model (only emitted when `resolveData` is given). */
  dataModel?: JsonObject;
  sendDataModel?: boolean;
}

/** v1.0 server→client function-call channel: ask the renderer to run a catalog function on the agent's behalf. */
export interface A2uiCallRendererFunction {
  functionCallId: string;
  /** `catalogId` is REQUIRED here (unlike the general `A2uiFunctionCall`) per the v1.0 schema. */
  callFunction: A2uiFunctionCall & { catalogId: string };
}

/** v1.0 `FunctionResponse` (shared shape for `agentFunctionResponse` and `rendererFunctionResponse`). */
export interface A2uiFunctionResponse {
  functionCallId: string;
  /** Exactly one of `value` / `error` is present (schema: `oneOf: [{required:[value]},{required:[error]}]`). */
  value?: JsonValue;
  error?: { code: string; message: string };
}

/**
 * A2UI envelope (v1.0 RC). Same single-message-key shape as {@link A2uiEnvelope}; `updateComponents` /
 * `updateDataModel` / `deleteSurface` are unchanged from v0.9.1 (reused as-is), `createSurface` is replaced
 * by the bundling-capable {@link A2uiCreateSurfaceV1}, and the function-call messages are new.
 */
export type A2uiEnvelopeV1 =
  | { version: string; createSurface: A2uiCreateSurfaceV1 }
  | { version: string; updateComponents: A2uiUpdateComponents }
  | { version: string; updateDataModel: A2uiUpdateDataModel }
  | { version: string; deleteSurface: A2uiDeleteSurface }
  | { version: string; callRendererFunction: A2uiCallRendererFunction }
  | { version: string; agentFunctionResponse: A2uiFunctionResponse };

/** Any A2UI server→client message this profile can emit, across both targets. */
export type A2uiMessage = A2uiEnvelope | A2uiEnvelopeV1;

// ─────────────────────────────────────────────────────────────────────────────
// Client→server messages (v0.9.1).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notification of a user interaction. `name` is the firing component's `action.event.name`,
 * and `context` is that action's `context` data bindings resolved to concrete values.
 * Verified unchanged in the v1.0 RC's `renderer_to_agent.json` (adds only optional `userMessage` /
 * `metadata`, not modeled here since `fromA2uiEvent` does not consume them).
 */
export interface A2uiAction {
  name: string;
  surfaceId: string;
  sourceComponentId: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  context: Record<string, JsonValue>;
}

/** Client-side error notification (validation failure, etc.). */
export interface A2uiError {
  code: string;
  message: string;
  surfaceId: string;
  /** JSON Pointer to the location of the validation failure (optional). */
  path?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Client→server messages (v1.0 RC additions). Verified against the v1.0 RC's
// `specification/v1_0/json/renderer_to_agent.json` + `common_types.json` (see the server→client
// section above for how they were fetched). The renderer-to-agent envelope adds two message kinds
// with no v0.9.1 equivalent and no kohaku concept behind them: `callAgentFunction` (the renderer asks
// the agent to run a named function) and `rendererFunctionResponse` (the renderer's reply to a prior
// `callRendererFunction`). kohaku's GuiAction model has no function-call channel, so `fromA2uiEvent`
// reports these as an explicit {@link A2uiUnsupportedResult} rather than silently dropping fields or
// guessing at a GuiAction shape.
// ─────────────────────────────────────────────────────────────────────────────

/** v1.0 client→agent: ask the agent to run a named catalog function on the renderer's behalf. */
export interface A2uiCallAgentFunction {
  surfaceId: string;
  functionCallId: string;
  callFunction: A2uiFunctionCall;
}

/** v1.0 client→agent: the renderer's reply to a prior `callRendererFunction`. Same shape as {@link A2uiFunctionResponse}. */
export type A2uiRendererFunctionResponse = A2uiFunctionResponse;

/** The v1.0 client→agent message kinds `fromA2uiEvent` newly accepts (beyond the unwrapped `A2uiAction`). */
export type A2uiClientEventV1 =
  | { callAgentFunction: A2uiCallAgentFunction }
  | { rendererFunctionResponse: A2uiRendererFunctionResponse };

/** Explicit "no kohaku equivalent" result for a v1.0 client message `fromA2uiEvent` cannot map to a `GuiAction`. */
export interface A2uiUnsupportedResult {
  kind: "unsupported";
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sidecar for kohaku-specific information (outside the A2UI wire).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where kohaku-specific information that cannot ride on the A2UI wire is preserved. Returned paired with the
 * A2UI messages (strictly v0.9.1-compliant) produced by {@link toA2ui} / {@link patchToA2ui}.
 *
 * `components` maps an A2UI component id → the originating kohaku `ComponentNode` (preserving type / props /
 * data.$ref / bind / visibleWhen losslessly). Spec / patch-level metadata is preserved alongside it.
 */
export interface KohakuSidecar {
  intent?: CanonicalIntent;
  provenance?: Provenance;
  dataVersion?: string;
  /** null means "the next Spec has no refVersions" = deletion (only from a SpecPatch). */
  refVersions?: Record<string, string> | null;
  /** null means state deletion (only from a SpecPatch). */
  state?: JsonObject | null;
  events?: EventBinding[];
  /** Only when derived from a SpecPatch: the target intent hash. */
  baseIntentHash?: string;
  /** A2UI component id → the original kohaku ComponentNode. */
  components: Record<string, ComponentNode>;
}

/** Return value of {@link toA2ui} / {@link patchToA2ui}. A pair of the strict A2UI message sequence and the kohaku sidecar. */
export interface A2uiConversion {
  /**
   * The sequence of A2UI wire messages (target of JSONL serialization), strictly compliant with the
   * requested `target` (defaults to v0.9.1; `A2uiEnvelopeV1` messages appear only when `target: "v1.0"` was requested).
   */
  messages: A2uiMessage[];
  /** Sidecar for kohaku-specific information (lossless preservation outside the wire). */
  sidecar: KohakuSidecar;
}
