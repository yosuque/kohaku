import { canonicalStringify, sha256Hex } from "./canonical-json.js";
import { type ActionParamsSchema, ActionParamsSchemaSchema } from "./schema/action-params.js";
import type { JsonObject, JsonValue } from "./schema/json.js";

/**
 * Governance tier for invoking an operation (design.md #62/#63). Default (when
 * `OperationDescriptor.tier` is omitted) is `"auto"`: no confirm/approval gate, matching the
 * pre-existing (ungated) invoke behavior.
 *
 * - `"auto"` — invoked as soon as params validate.
 * - `"confirm"` — the request body must additionally carry `confirmed: true`, or the host responds
 *   403 `APPROVAL_REQUIRED` (tier `"confirm"`). No token is involved; it is a same-request
 *   acknowledgement, not a delegated grant.
 * - `"approve"` — the request must additionally carry a valid, unexpired, unused approval token
 *   bound to this exact `(action, payloadHash, requester)`, issued by someone other than the
 *   requester (design.md #63).
 */
export type ActionTier = "auto" | "confirm" | "approve";

/** One problem `validateActionParams` found in a payload against an `ActionParamsSchema`. */
export interface ActionParamIssue {
  /**
   * Dot-separated path into the payload (empty string for a whole-payload problem, e.g. the payload
   * itself is not an object). An array index is rendered as `[i]` appended to its parent path (e.g.
   * `"tags[0]"`), matching the convention Python's `spec/action_params.py` mirrors byte-for-byte in
   * the cross-language golden.
   */
  path: string;
  /**
   * A stable machine-readable discriminator: `"type"`, `"required"`, `"additionalProperties"`,
   * `"enum"`, `"minimum"`, `"maximum"`, `"minLength"`, `"maxLength"`, `"maxItems"`, or `"unsafeKey"`.
   */
  code: string;
  /** Client-safe explanation (or the schema author's own `x-message` override). */
  message: string;
}

/**
 * Object-key names that are always rejected as a payload property, at any nesting depth, regardless of
 * the schema's own `additionalProperties` setting. `__proto__` (and, on some engines, `constructor` /
 * `prototype`) resolve through the prototype chain rather than the object's own properties when read
 * with a plain `obj[key]` / `key in obj`, which can otherwise let a value silently bypass both schema
 * lookup (`properties[key]` resolves to an inherited `Object.prototype` member instead of `undefined`,
 * so it is treated as "no schema for this property" without the `additionalProperties: false` check ever
 * firing) and type validation (the inherited value is not an `ActionParamsSchema`, so `validateValue`'s
 * `switch (schema.type)` matches nothing and reports no issue at all). This check runs independently of
 * that lookup bug being fixed (`Object.hasOwn` throughout, below) as defense in depth: a payload that
 * reaches this validator is expected to end up as literal DomainPort.invoke arguments, which may later be
 * merged or spread by code this validator has no visibility into.
 */
const UNSAFE_PROPERTY_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function joinPath(base: string, key: string): string {
  return base === "" ? key : `${base}.${key}`;
}

function joinIndex(base: string, index: number): string {
  return `${base}[${index}]`;
}

/**
 * Validates `payload` against the given subset schema (see `schema/action-params.ts`) and returns
 * every problem found (empty array = valid). Assumes `schema` has already been checked for
 * unknown/disallowed keywords (host-core's `createOperationIndex` does this once, at attach time, via
 * `assertValidActionParamsSchema` below) — this function does not re-check the schema's own shape, only
 * the payload against it, so it stays cheap to call on every invoke.
 *
 * Also assumes `payload` has already passed the JSON depth precheck (`schema/json.ts`'s
 * `JsonObjectSchema` / `exceedsMaxJsonDepth`) — every caller receives `payload` only after it parsed as
 * a `JsonObject`, so this function does not re-derive that bound.
 */
export function validateActionParams(schema: ActionParamsSchema, payload: JsonObject): ActionParamIssue[] {
  const issues: ActionParamIssue[] = [];
  validateValue(schema, payload, "", issues);
  return issues;
}

function validateValue(
  schema: ActionParamsSchema,
  value: JsonValue,
  path: string,
  issues: ActionParamIssue[],
): void {
  const messageOverride = schema["x-message"];
  const report = (code: string, message: string) => {
    issues.push({ path, code, message: messageOverride ?? message });
  };

  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        report("type", `expected an object at "${path || "(root)"}"`);
        return;
      }
      const obj = value as JsonObject;
      for (const key of schema.required ?? []) {
        // Object.hasOwn (not `in`): `in` also matches an inherited Object.prototype member (e.g.
        // "constructor", "toString"), which would report a required field of that name as present even
        // when the payload never actually carried it.
        if (!Object.hasOwn(obj, key)) {
          issues.push({
            path: joinPath(path, key),
            code: "required",
            message: messageOverride ?? `missing required property "${key}"`,
          });
        }
      }
      const props = schema.properties ?? {};
      for (const key of Object.keys(obj)) {
        const propPath = joinPath(path, key);
        if (UNSAFE_PROPERTY_KEYS.has(key)) {
          issues.push({
            path: propPath,
            code: "unsafeKey",
            message: messageOverride ?? `the property name "${key}" is not allowed`,
          });
          continue;
        }
        // Object.hasOwn (not a plain `props[key]`): `properties` is a plain object, so bracket access
        // for a key like "constructor" or "toString" resolves through the prototype chain to an
        // inherited Object.prototype member instead of `undefined` -- a truthy, non-ActionParamsSchema
        // value that would otherwise both skip the additionalProperties check below (propSchema is
        // "defined") and validate against nothing (its `.type` is undefined, so `validateValue`'s switch
        // matches no case and silently reports no issue).
        const propSchema = Object.hasOwn(props, key) ? props[key] : undefined;
        if (propSchema === undefined) {
          if (schema.additionalProperties === false) {
            issues.push({
              path: propPath,
              code: "additionalProperties",
              message: messageOverride ?? `unexpected property "${key}"`,
            });
          }
          continue;
        }
        validateValue(propSchema, obj[key], propPath, issues);
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) {
        report("type", `expected an array at "${path || "(root)"}"`);
        return;
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        report("maxItems", `expected at most ${schema.maxItems} items`);
      }
      if (schema.items !== undefined) {
        const itemSchema = schema.items;
        value.forEach((item, index) => {
          validateValue(itemSchema, item, joinIndex(path, index), issues);
        });
      }
      return;
    }
    case "string": {
      if (typeof value !== "string") {
        report("type", `expected a string at "${path || "(root)"}"`);
        return;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        report("minLength", `expected at least ${schema.minLength} characters`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        report("maxLength", `expected at most ${schema.maxLength} characters`);
      }
      if (schema.enum !== undefined && !schema.enum.includes(value)) {
        report("enum", `expected one of ${canonicalStringify(schema.enum)}`);
      }
      return;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || (schema.type === "integer" && !Number.isInteger(value))) {
        report(
          "type",
          `expected a${schema.type === "integer" ? "n integer" : " number"} at "${path || "(root)"}"`,
        );
        return;
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        report("minimum", `expected at least ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        report("maximum", `expected at most ${schema.maximum}`);
      }
      if (schema.enum !== undefined && !schema.enum.includes(value)) {
        report("enum", `expected one of ${canonicalStringify(schema.enum)}`);
      }
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        report("type", `expected a boolean at "${path || "(root)"}"`);
        return;
      }
      if (schema.enum !== undefined && !schema.enum.includes(value)) {
        report("enum", `expected one of ${canonicalStringify(schema.enum)}`);
      }
      return;
    }
  }
}

/**
 * Thrown by `assertValidActionParamsSchema` when a `paramsSchema` uses a keyword outside the closed
 * subset (or is otherwise structurally invalid, e.g. `additionalProperties: true`). This is an
 * authoring-time error (a product's `DomainPort.listOperations()` returned a bad schema), not a
 * request-time one — it is never surfaced to a UI client as an `ACTION_PARAMS_INVALID` response.
 */
export class ActionParamsSchemaError extends Error {
  constructor(operationName: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`operation "${operationName}" has an invalid paramsSchema: ${detail}`);
    this.name = "ActionParamsSchemaError";
  }
}

/**
 * Validates that `schema` uses only the allowed subset of keywords (`schema/action-params.ts`'s
 * `ActionParamsSchemaSchema`), throwing `ActionParamsSchemaError` if not. Called once per operation at
 * attach time (host-core's `createOperationIndex`), not per request — a per-request `validateActionParams`
 * call assumes this has already run.
 */
export function assertValidActionParamsSchema(operationName: string, schema: JsonValue): ActionParamsSchema {
  const result = ActionParamsSchemaSchema.safeParse(schema);
  if (!result.success) {
    throw new ActionParamsSchemaError(operationName, result.error);
  }
  return result.data;
}

/**
 * `sha256:<hex>` of the canonical JSON of an action's invoke payload (the same `sha256:<hex>` shape as
 * `computeIntentHash` / `computeSpecHash` / `computePolicyId`). Used to bind an approval token to the
 * exact payload it was granted for (design.md #63) and as the lineage-recorded summary of a payload
 * (`action.invoked` / `action.denied` / `action.approvalRequested` record only this hash by default,
 * never the payload itself — see host-core's `ActionAuditRecorder`).
 */
export async function actionPayloadHash(payload: JsonObject): Promise<string> {
  const hex = await sha256Hex(canonicalStringify(payload));
  return `sha256:${hex}`;
}
