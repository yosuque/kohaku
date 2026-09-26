import type { JsonObject, JsonValue } from "@kohaku-ui/spec-core";
import type { A2uiComponent } from "../types.js";
import { RESERVED_OBJECT_KEYS } from "./reserved-keys.js";
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
 *
 * **Security**: also rejects a reserved id (see {@link RESERVED_OBJECT_KEYS}) and stores the result on a
 * null-prototype object (`Object.create(null)`), the same two-layer defense `setAtPointer`/`getAtPointer`
 * use — `A2uiComponentSchema` already rejects a reserved `id` at the schema layer (so this should be
 * unreachable in practice), but the plain `next[c.id] = c` this function used before would, on an ordinary
 * object, have let `id: "__proto__"` reassign `next`'s own prototype instead of storing a component.
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
    if (RESERVED_OBJECT_KEYS.has(c.id)) {
      throw new A2uiIngestError(`component id "${c.id}" is reserved and cannot be used`);
    }
    seen.add(c.id);
  }
  const next: Record<string, A2uiComponent> = Object.create(null) as Record<string, A2uiComponent>;
  for (const key of Object.keys(base)) next[key] = base[key] as A2uiComponent;
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
 *
 * **Security**: rejects any token in {@link RESERVED_OBJECT_KEYS} (`__proto__`/`constructor`/`prototype`).
 * Without this, `updateDataModel({path: "/__proto__/polluted", value: "yes"})` would let a third-party agent
 * reach `setAtPointer`'s `cursor[token] = child` with `token === "__proto__"` — on an ordinary object this is
 * not a plain property write, it *reassigns the object's own prototype* (the accessor every object inherits
 * from `Object.prototype`). The result is a `dataModel` whose injected value is invisible to
 * `canonicalStringify`/`JSON.stringify` (own-enumerable-only, so `deriveDataVersion` hashes it identically to
 * the unmodified data model — a cache-key collision) yet *is* visible to a plain `cursor[token]` read
 * (property lookup walks the prototype chain) — exactly the kind of same-key-different-content drift
 * `createA2uiIngest`'s cache is supposed to make impossible. Rejecting the token here (defense layer 1) is
 * paired with the walkers below never reading/writing anything but each object's own properties regardless
 * of key name (defense layer 2, independent of this list).
 */
export function parsePointer(pointer: string): string[] {
  if (pointer === "" || pointer === "/") return [];
  if (!pointer.startsWith("/")) {
    throw new A2uiIngestError(
      `updateDataModel path must be RFC 6901 ("" , "/", or starting with "/"), got "${pointer}"`,
    );
  }
  const tokens = pointer.slice(1).split("/").map(unescapeJsonPointerToken);
  for (const token of tokens) {
    if (RESERVED_OBJECT_KEYS.has(token)) {
      throw new A2uiIngestError(
        `updateDataModel path must not address the reserved property name "${token}", got path "${pointer}"`,
      );
    }
  }
  return tokens;
}

/**
 * Shallow-clones `obj`'s own enumerable properties onto a fresh, prototype-*less* object (`Object.create(null)`).
 * A null-prototype object has no inherited `__proto__` accessor at all, so a later `clone[token] = value` is an
 * ordinary property write regardless of what `token` is — the walkers below use this for every object they
 * construct, as the second, key-name-independent defense layer described in `parsePointer`'s doc.
 * `JSON.stringify`/`canonicalStringify` serialize a null-prototype object identically to a plain one (both
 * only ever look at own enumerable properties), so this is invisible to every other consumer of `JsonObject`.
 */
function cloneOwn(obj: JsonObject): JsonObject {
  const clone: JsonObject = Object.create(null) as JsonObject;
  for (const key of Object.keys(obj)) clone[key] = obj[key] as JsonValue;
  return clone;
}

/**
 * Reads the value at `pointer` within `root` (RFC 6901, same `"/"`-means-whole-document convention as
 * `parsePointer`). Returns `undefined` when any segment of the path does not exist as an *own* property of
 * its parent (see `parsePointer`'s security note — this also stops a path like `/toString` from resolving to
 * an inherited `Object.prototype` member as if it were stored data) — a read, unlike a write, has no reason
 * to distinguish "absent" from "present but not an object" (either way there is nothing to return). Used by
 * `from-a2ui.ts` to snapshot a `{path}` data binding to a literal value.
 */
export function getAtPointer(root: JsonObject, pointer: string): JsonValue | undefined {
  const tokens = parsePointer(pointer);
  let cursor: JsonValue = root;
  for (const token of tokens) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return undefined;
    if (!Object.hasOwn(cursor, token)) return undefined;
    cursor = (cursor as JsonObject)[token] as JsonValue;
  }
  return cursor;
}

/**
 * Sets `value` at `tokens` within `root`, creating intermediate objects as needed (an existing non-object
 * value along the path is replaced by a fresh object, not merged into). An empty `tokens` array (path `"/"`)
 * replaces the whole data model, which therefore requires an object `value` — kohaku's `SurfaceState.dataModel`
 * is always a `JsonObject`, so replacing it wholesale with a bare scalar/array has no representation here.
 * See `parsePointer`/`cloneOwn`'s doc comments for why every object here is built via `cloneOwn`/
 * `Object.create(null)` rather than `{...existing}`/`{}`.
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
    return cloneOwn(value);
  }
  const next = cloneOwn(root);
  let cursor: JsonObject = next;
  for (const token of tokens.slice(0, -1)) {
    const existing = Object.hasOwn(cursor, token) ? cursor[token] : undefined;
    const child: JsonObject = isJsonObjectValue(existing)
      ? cloneOwn(existing)
      : (Object.create(null) as JsonObject);
    cursor[token] = child;
    cursor = child;
  }
  cursor[tokens[tokens.length - 1]!] = value;
  return next;
}

/**
 * Deletes the key at `tokens` within `root` (v0.9.1 only — see `A2uiUpdateDataModelV091Schema`'s doc). A
 * missing intermediate segment is a no-op (fail-open: nothing to delete), and an empty `tokens` array (path
 * `"/"`) resets the whole data model to `{}`. See `setAtPointer`'s doc for why `cloneOwn`/`Object.create(null)`.
 */
function deleteAtPointer(root: JsonObject, tokens: readonly string[]): JsonObject {
  if (tokens.length === 0) return Object.create(null) as JsonObject;
  const next = cloneOwn(root);
  let cursor: JsonObject = next;
  for (const token of tokens.slice(0, -1)) {
    const existing = Object.hasOwn(cursor, token) ? cursor[token] : undefined;
    if (!isJsonObjectValue(existing)) return next;
    const child = cloneOwn(existing);
    cursor[token] = child;
    cursor = child;
  }
  const lastToken = tokens[tokens.length - 1]!;
  if (Object.hasOwn(cursor, lastToken)) delete cursor[lastToken];
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
