/**
 * Property names that must never be used as an object key derived from untrusted input (a JSON Pointer
 * token, a component id) in this module, because a naive `obj[key] = value` / `obj[key]` on an ordinary
 * object treats them specially: `"__proto__"` is an accessor inherited from `Object.prototype` that
 * *reassigns the object's own `[[Prototype]]`* on write and returns the current prototype on read (not an
 * ordinary data property at all), while `"constructor"`/`"prototype"` shadow well-known `Object.prototype`
 * members whose presence downstream code could reasonably assume means something else entirely. Rejecting
 * exactly these three (the same minimal set long-standing prototype-pollution fixes elsewhere in the JS
 * ecosystem use) at the point untrusted input becomes a key closes the concrete exploit
 * (`updateDataModel({path: "/__proto__/x", value: "y"})`, a component `id: "__proto__"`) without having to
 * reason about every other inherited `Object.prototype` member individually. See `reduce.ts`'s
 * `parsePointer` and `schemas.ts`'s `A2uiComponentSchema` for where this is enforced, and `reduce.ts`'s own
 * `Object.hasOwn`-based walkers for the independent, broader defense (own-properties-only, regardless of
 * key name) that backs this up.
 */
export const RESERVED_OBJECT_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
