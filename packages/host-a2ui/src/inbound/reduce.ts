import type { JsonObject, JsonValue } from "@kohaku-ui/spec-core";
import type { A2uiComponent } from "../types.js";
import type { InboundA2uiMessage } from "./schemas.js";

/** The single component id an inbound surface's root must have (matches kohaku's own root convention — see spec-core's `ROOT_COMPONENT_ID`). */
export const A2UI_ROOT_COMPONENT_ID = "root";

/** Raised on anything the ingest pipeline treats as a hard failure (a malformed sequence of otherwise-schema-valid messages, an unresolvable root, etc.). */
export class A2uiIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "A2uiIngestError";
  }
}

/**
 * The accumulated state of one A2UI surface, folded from the sequence of `createSurface` /
 * `updateComponents` / `updateDataModel` messages seen so far for it.
 */
export interface SurfaceState {
  surfaceId: string;
  /**
   * The surface's default catalogId (from `createSurface`). Absent is legal per the v1.0 RC facts note (a
   * surface with no default — every component/function call must then carry its own `catalogId`).
   */
  catalogId?: string;
  sendDataModel: boolean;
  /** Every component seen so far, keyed by id (upsert semantics — see `upsertComponents`). */
  components: Record<string, A2uiComponent>;
  dataModel: JsonObject;
}

function isJsonObjectValue(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Upserts an incoming `components` array onto an existing map (id match replaces, matching the "A2UI has no
 * component-delete message, updateComponents is upsert-only" fact this profile's outbound side already
 * relies on). Rejects a *duplicate id within the same incoming array* — two components both claiming, say,
 * `id: "root"` in one message is a malformed message, not a legal "last one wins" upsert.
 */
function upsertComponents(
  base: Record<string, A2uiComponent>,
  incoming: readonly A2uiComponent[],
): Record<string, A2uiComponent> {
  const seen = new Set<string>();
  for (const c of incoming) {
    if (seen.has(c.id)) {
      throw new A2uiIngestError(
        `duplicate component id "${c.id}" within a single createSurface/updateComponents message`,
      );
    }
    seen.add(c.id);
  }
  const next = { ...base };
  for (const c of incoming) next[c.id] = c;
  return next;
}

/** RFC 6901 token unescaping (~1 → /, ~0 → ~; unescape ~ last, mirroring `to-a2ui.ts`'s escape order reversed). */
function unescapeJsonPointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Splits an RFC 6901 pointer into its unescaped tokens. `""` and `"/"` (the RC facts note's stated default)
 * both mean "the whole data model" here — no token, not a property named `""` — since A2UI's own updateDataModel
 * examples use `"/"` as the "whole document" default rather than RFC 6901's literal (and rarely useful) empty-string-key
 * reading of a bare `"/"`.
 */
function parsePointer(pointer: string): string[] {
  if (pointer === "" || pointer === "/") return [];
  if (!pointer.startsWith("/")) {
    throw new A2uiIngestError(
      `updateDataModel path must be RFC 6901 ("" , "/", or starting with "/"), got "${pointer}"`,
    );
  }
  return pointer.slice(1).split("/").map(unescapeJsonPointerToken);
}

/**
 * Sets `value` at `tokens` within `root`, creating intermediate objects as needed (an existing non-object
 * value along the path is replaced by a fresh object, not merged into). An empty `tokens` array (path `"/"`)
 * replaces the whole data model, which therefore requires an object `value` — kohaku's `SurfaceState.dataModel`
 * is always a `JsonObject`, so replacing it wholesale with a bare scalar/array has no representation here.
 *
 * Array-valued intermediate segments are not specially handled (an array along the path is simply replaced
 * by a fresh object for the remaining descent, same as any other non-object) — the RC facts note does not
 * document array-index semantics for this pointer; verify against the A2UI v1.0 spec if precise list
 * addressing inside the data model ever becomes load-bearing for kohaku's own ingest.
 */
function setAtPointer(root: JsonObject, tokens: readonly string[], value: JsonValue): JsonObject {
  if (tokens.length === 0) {
    if (!isJsonObjectValue(value)) {
      throw new A2uiIngestError(
        'updateDataModel: replacing the whole data model (path "/") requires an object value',
      );
    }
    return value;
  }
  const next: JsonObject = { ...root };
  let cursor: JsonObject = next;
  for (const token of tokens.slice(0, -1)) {
    const existing = cursor[token];
    const child: JsonObject = isJsonObjectValue(existing) ? { ...existing } : {};
    cursor[token] = child;
    cursor = child;
  }
  cursor[tokens[tokens.length - 1]!] = value;
  return next;
}

/**
 * Deletes the key at `tokens` within `root` (v0.9.1 only — see `A2uiUpdateDataModelV091Schema`'s doc). A
 * missing intermediate segment is a no-op (fail-open: nothing to delete), and an empty `tokens` array (path
 * `"/"`) resets the whole data model to `{}`.
 */
function deleteAtPointer(root: JsonObject, tokens: readonly string[]): JsonObject {
  if (tokens.length === 0) return {};
  const next: JsonObject = { ...root };
  let cursor: JsonObject = next;
  for (const token of tokens.slice(0, -1)) {
    const existing = cursor[token];
    if (!isJsonObjectValue(existing)) return next;
    const child = { ...existing };
    cursor[token] = child;
    cursor = child;
  }
  delete cursor[tokens[tokens.length - 1]!];
  return next;
}

/** The surfaceId a given inbound message targets (every one of the 4 message kinds carries exactly one). */
export function surfaceIdOf(message: InboundA2uiMessage): string {
  if ("createSurface" in message) return message.createSurface.surfaceId;
  if ("updateComponents" in message) return message.updateComponents.surfaceId;
  if ("updateDataModel" in message) return message.updateDataModel.surfaceId;
  return message.deleteSurface.surfaceId;
}

/**
 * Folds one inbound message onto the current state of the one surface it targets. `state` is `undefined`
 * when the surface does not exist yet (legal only for `createSurface`); the return value is `undefined`
 * after `deleteSurface` (the surface no longer exists).
 *
 * - `createSurface`: creates the surface (error if it already exists — surfaceId/catalogId are fixed after
 *   creation per the RC facts note; delete and recreate to change them), folding in any bundled `components`
 *   / `dataModel` (v1.0 only).
 * - `updateComponents`: upserts onto the existing surface's components (error if the surface does not exist).
 * - `updateDataModel`: sets (or, v0.9.1 only, deletes when `value` is omitted) the data model at `path`
 *   (default `"/"`) (error if the surface does not exist).
 * - `deleteSurface`: removes the surface. Targeting an already-absent surface is a fail-open no-op (mirrors
 *   the "delete is idempotent" behavior most wire protocols give this kind of message).
 */
export function reduceSurfaceMessage(
  state: SurfaceState | undefined,
  message: InboundA2uiMessage,
): SurfaceState | undefined {
  if ("createSurface" in message) {
    const body = message.createSurface;
    if (state != null) {
      throw new A2uiIngestError(
        `surface "${body.surfaceId}" already exists (createSurface may only be sent once per surface; ` +
          "delete and recreate it to change surfaceId/catalogId)",
      );
    }
    let next: SurfaceState = {
      surfaceId: body.surfaceId,
      ...(body.catalogId != null ? { catalogId: body.catalogId } : {}),
      sendDataModel: body.sendDataModel ?? false,
      components: {},
      dataModel: {},
    };
    if ("components" in body && body.components != null) {
      next = { ...next, components: upsertComponents(next.components, body.components) };
    }
    if ("dataModel" in body && body.dataModel != null) {
      next = { ...next, dataModel: body.dataModel };
    }
    return next;
  }

  if ("updateComponents" in message) {
    const body = message.updateComponents;
    if (state == null) {
      throw new A2uiIngestError(
        `updateComponents targets unknown surface "${body.surfaceId}" (createSurface must come first)`,
      );
    }
    return { ...state, components: upsertComponents(state.components, body.components) };
  }

  if ("updateDataModel" in message) {
    const body = message.updateDataModel;
    if (state == null) {
      throw new A2uiIngestError(
        `updateDataModel targets unknown surface "${body.surfaceId}" (createSurface must come first)`,
      );
    }
    const tokens = parsePointer(body.path ?? "/");
    // v1.0's schema requires `value`; v0.9.1's makes it optional (omission deletes the key — see
    // A2uiUpdateDataModelV091Schema's doc). "value" in body is the discriminator between the two here.
    if ("value" in body && body.value !== undefined) {
      return { ...state, dataModel: setAtPointer(state.dataModel, tokens, body.value) };
    }
    return { ...state, dataModel: deleteAtPointer(state.dataModel, tokens) };
  }

  // deleteSurface
  const body = message.deleteSurface;
  if (state == null || state.surfaceId !== body.surfaceId) return state;
  return undefined;
}

/**
 * Folds one inbound message onto a registry of surfaces (`surfaceId -> SurfaceState`), the shape
 * `createA2uiIngest` (`ingest.ts`) accumulates across calls. Returns a new map (the input is never mutated).
 */
export function reduceSurfaces(
  surfaces: ReadonlyMap<string, SurfaceState>,
  message: InboundA2uiMessage,
): Map<string, SurfaceState> {
  const surfaceId = surfaceIdOf(message);
  const updated = reduceSurfaceMessage(surfaces.get(surfaceId), message);
  const next = new Map(surfaces);
  if (updated == null) next.delete(surfaceId);
  else next.set(surfaceId, updated);
  return next;
}

/**
 * The surface's root component (`id === "root"`). Per the RC facts note, a surface's Surface container
 * mounts exactly one such component as its child; `upsertComponents`' duplicate-id-within-one-array guard
 * already rules out two components both claiming `id: "root"` surviving into the same `SurfaceState` (a
 * later `updateComponents` upsert simply replaces the earlier "root", it does not duplicate it) — so the only
 * failure mode left to check here is "no root yet".
 */
export function getRootComponent(state: SurfaceState): A2uiComponent {
  const root = state.components[A2UI_ROOT_COMPONENT_ID];
  if (root == null) {
    throw new A2uiIngestError(
      `surface "${state.surfaceId}" has no root component (id "${A2UI_ROOT_COMPONENT_ID}")`,
    );
  }
  return root;
}
