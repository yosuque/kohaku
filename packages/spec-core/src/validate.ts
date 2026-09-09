import { collectStateRefs } from "./predicate.js";
import { parseQueryRef } from "./query-ref.js";
import type { UISpec } from "./schema/spec.js";

export const ROOT_COMPONENT_ID = "root";

/**
 * The upper bound on the total number of bind variants enumerable per Spec (curbing Cartesian-product
 * explosion). When the sum of the Cartesian products of each data.$ref's bound-parameter values exceeds
 * this, it is BIND_VARIANT_LIMIT. Prevents capability issuance at compose time (a read scope per
 * variant) from blowing up and bloating the token.
 */
export const MAX_BIND_VARIANTS = 256;

export type SpecIssueCode =
  | "DUPLICATE_ID"
  | "MISSING_ROOT"
  | "DANGLING_CHILD"
  | "CYCLE"
  | "ORPHAN_COMPONENT"
  | "MULTIPLE_SANDBOX_NODES"
  | "UNKNOWN_EVENT_TARGET"
  // --- Client-local state (kohaku >= 0.2) ---
  | "STATE_REF_UNKNOWN"
  | "STATE_SET_INVALID"
  | "VERSION_FEATURE_MISMATCH"
  // --- Two-way binding data.bind (kohaku >= 0.2 [Draft]) ---
  | "BIND_STATE_UNKNOWN"
  | "BIND_PARAM_MISSING"
  | "BIND_VALUE_INVALID"
  | "BIND_PARAM_RESERVED"
  | "BIND_VARIANT_LIMIT"
  // --- Server-side paging/sorting ---
  | "REF_RESERVED_PARAM"
  // --- Composer-time reference constraint (ComposePolicy.refConstraint) ---
  // Both codes below are emitted by the composer's L1 repair-loop set-membership check (packages/composer's
  // l1-generate.ts `collectIssues`, mirrored by python/kohaku's l1_generate.py `_collect_issues`) after a
  // generated component's `data.$ref` turns out not to be one of the resolved QueryHandle URIs for this
  // compose — never by `validateSpecStructure` in this module, which only sees the Spec itself and has no
  // access to the resolved reference set. They are included in this shared taxonomy purely so the code
  // names are stable across the TS and Python implementations and across documentation; a consumer
  // exhaustively switching on `SpecIssueCode` should treat both as reachable only via composer feedback,
  // never as an output of `validateSpecStructure`.
  /**
   * Emitted under the default `ComposePolicy.refConstraint` ("schema"): the generation schema already
   * constrains `data.$ref` to an enum of the resolved URIs, so an out-of-set value reaching this check is a
   * bypass of that schema-stage enforcement (e.g. via the prompt-JSON fallback path, which does not enforce
   * the enum) rather than the constraint's expected operating mode.
   */
  | "INVALID_REF"
  /**
   * Emitted under `ComposePolicy.refConstraint === "validate"`: the generation schema never constrained
   * `data.$ref` to an enum in the first place (it is relaxed to a plain string), so this check is the
   * *primary* enforcement mechanism for that mode, not a bypass backstop — the distinct code name lets a
   * consumer tell the two operating modes apart.
   */
  | "DATA_REF_UNRESOLVED";

export interface SpecIssue {
  code: SpecIssueCode;
  severity: "error" | "warning";
  path: string;
  message: string;
}

/**
 * Structural validation that is hard to express in Zod (made a standalone function to keep error codes
 * stable): ID uniqueness / root existence / resolution of children references / a DAG rooted at root
 * (acyclic) / unreachable components as warnings / existence of event targets.
 */
export function validateSpecStructure(spec: UISpec): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const byId = new Map<string, (typeof spec.components)[number]>();

  for (const [i, c] of spec.components.entries()) {
    if (byId.has(c.id)) {
      issues.push({
        code: "DUPLICATE_ID",
        severity: "error",
        path: `components[${i}].id`,
        message: `component id "${c.id}" is duplicated`,
      });
    } else {
      byId.set(c.id, c);
    }
  }

  if (!byId.has(ROOT_COMPONENT_ID)) {
    issues.push({
      code: "MISSING_ROOT",
      severity: "error",
      path: "components",
      message: `a component with id "${ROOT_COMPONENT_ID}" is required`,
    });
  }

  for (const [i, c] of spec.components.entries()) {
    for (const child of c.children ?? []) {
      if (!byId.has(child)) {
        issues.push({
          code: "DANGLING_CHILD",
          severity: "error",
          path: `components[${i}].children`,
          message: `component "${c.id}" references missing child "${child}"`,
        });
      }
    }
  }

  // DFS from root checks reachability and cycles (children may be shared as a DAG).
  const reachable = new Set<string>();
  if (byId.has(ROOT_COMPONENT_ID)) {
    const inStack = new Set<string>();
    const visit = (id: string): void => {
      if (inStack.has(id)) {
        issues.push({
          code: "CYCLE",
          severity: "error",
          path: `components`,
          message: `cycle detected through component "${id}"`,
        });
        return;
      }
      if (reachable.has(id)) return;
      reachable.add(id);
      inStack.add(id);
      const node = byId.get(id);
      for (const child of node?.children ?? []) {
        if (byId.has(child)) visit(child);
      }
      inStack.delete(id);
    };
    visit(ROOT_COMPONENT_ID);

    for (const c of spec.components) {
      if (!reachable.has(c.id)) {
        issues.push({
          code: "ORPHAN_COMPONENT",
          severity: "warning",
          path: `components`,
          message: `component "${c.id}" is not reachable from "${ROOT_COMPONENT_ID}"`,
        });
      }
    }
  }

  // The composer only ever emits a single L2 (sandboxed free-generation) node per Spec, and
  // lineage.viewComposed relies on that invariant when it picks "the" sandbox node to record as
  // component.generated. A second one would silently make lineage record only the first and drop the
  // rest, so flag it as a warning rather than let it fail silently.
  const sandboxNodes = spec.components.filter((c) => c.artifact != null);
  if (sandboxNodes.length > 1) {
    issues.push({
      code: "MULTIPLE_SANDBOX_NODES",
      severity: "warning",
      path: "components",
      message: `expected at most one component with an artifact (L2 sandbox node), found ${sandboxNodes.length}`,
    });
  }

  // SPEC §2.3: a Spec's $ref itself MUST NOT contain a reserved parameter (leading `_`).
  // Reserved parameters are the wire representation the client's resolve(ref, {page, sort}) appends and
  // are exempt from capability verification (exact match against the base ref), so contaminating the
  // Spec side would break the authorization premise.
  for (const [i, c] of spec.components.entries()) {
    if (c.data?.$ref == null) continue;
    let refParams: Record<string, string>;
    try {
      refParams = parseQueryRef(c.data.$ref).params;
    } catch {
      continue; // Invalidity of $ref itself is a concern of the schema regex / the client (not checked here).
    }
    for (const key of Object.keys(refParams)) {
      if (key.startsWith("_")) {
        issues.push({
          code: "REF_RESERVED_PARAM",
          severity: "error",
          path: `components[${i}].data.$ref`,
          message: `$ref must not contain the reserved parameter "${key}" (parameters starting with \`_\` are wire-only, applied at resolve time)`,
        });
      }
    }
  }

  for (const [i, e] of spec.events.entries()) {
    // Avoid a non-null assertion: even if the split result is empty, falling back to "" makes byId.has
    // reliably report a miss.
    const targetId = e.on.split(".")[0] ?? "";
    if (!byId.has(targetId)) {
      issues.push({
        code: "UNKNOWN_EVENT_TARGET",
        severity: "error",
        path: `events[${i}].on`,
        message: `event target component "${targetId}" does not exist`,
      });
    }
  }

  validateState(spec, issues);
  validateBind(spec, issues);

  return issues;
}

/**
 * Validation of client-local state (kohaku >= 0.2). Adds three error codes:
 * - VERSION_FEATURE_MISMATCH: kohaku="0.1" yet it contains state / visibleWhen / state.set (the feature
 *   gate).
 * - STATE_REF_UNKNOWN: visibleWhen.ref's `$state.<key>` has no initial value in spec.state (guaranteeing
 *   determinism of the initial render — an unknown key becomes an undefined comparison and rendering
 *   could be non-deterministic).
 * - STATE_SET_INVALID: an emit:"state.set" payload has no static-string key, or the key is absent from
 *   spec.state (preventing writes to an undeclared key at runtime / a template key that leaves the
 *   target undetermined).
 */
function validateState(spec: UISpec, issues: SpecIssue[]): void {
  const stateKeys = spec.state != null ? new Set(Object.keys(spec.state)) : new Set<string>();
  const usesStateFeature =
    spec.state != null ||
    spec.components.some((c) => c.visibleWhen != null) ||
    spec.components.some((c) => c.data?.bind != null) ||
    spec.events.some((e) => e.emit === "state.set");

  if (spec.kohaku === "0.1" && usesStateFeature) {
    issues.push({
      code: "VERSION_FEATURE_MISMATCH",
      severity: "error",
      path: "kohaku",
      message: `state / visibleWhen / state.set / data.bind require kohaku >= 0.2 (current "${spec.kohaku}")`,
    });
  }

  for (const [i, c] of spec.components.entries()) {
    if (c.visibleWhen == null) continue;
    // Recursively collect the referenced keys of every leaf, including compound predicates (all / any /
    // not), and check whether an initial value exists. Fold with a Set to avoid duplicate reports of the
    // same key (deterministic, since traversal order is preserved).
    for (const key of new Set(collectStateRefs(c.visibleWhen))) {
      if (!stateKeys.has(key)) {
        issues.push({
          code: "STATE_REF_UNKNOWN",
          severity: "error",
          path: `components[${i}].visibleWhen`,
          message: `state key "${key}" referenced by visibleWhen has no initial value in spec.state`,
        });
      }
    }
  }

  for (const [i, e] of spec.events.entries()) {
    if (e.emit !== "state.set") continue;
    const key = e.payload["key"];
    // key must be a static string ($value / $row.* templates or non-strings are not allowed).
    if (typeof key !== "string" || key.startsWith("$")) {
      issues.push({
        code: "STATE_SET_INVALID",
        severity: "error",
        path: `events[${i}].payload.key`,
        message: `state.set payload.key must be a static state key string`,
      });
    } else if (!stateKeys.has(key)) {
      issues.push({
        code: "STATE_SET_INVALID",
        severity: "error",
        path: `events[${i}].payload.key`,
        message: `state.set target key "${key}" is not declared in spec.state`,
      });
    }
  }
}

/**
 * Structural validation of two-way binding data.bind (kohaku >= 0.2 [Draft]).
 * To guarantee that the initial effective ref = $ref itself, it enforces a **three-way match** of the
 * initial values (`$ref`'s corresponding parameter value = `spec.state[$state key]` = an element of
 * `values`). If this breaks, the initial render becomes non-deterministic and the premises of fixation,
 * capability enumeration, and freshness matching also break.
 *
 * - BIND_STATE_UNKNOWN: the `bind.<param>.$state` key has no initial value in spec.state.
 * - BIND_PARAM_RESERVED: a bound parameter key starts with `_` (colliding with the reserved namespace —
 *   the authorization-exempt region).
 * - BIND_PARAM_MISSING: a bound parameter key is absent from $ref (no initial value to overwrite).
 * - BIND_VALUE_INVALID: $ref's corresponding value is not in values, or does not match
 *   String(spec.state[key]).
 * - BIND_VARIANT_LIMIT: the whole Spec's total variant count (the sum of each ref's values Cartesian
 *   product) exceeds the limit.
 */
function validateBind(spec: UISpec, issues: SpecIssue[]): void {
  const stateKeys = spec.state != null ? new Set(Object.keys(spec.state)) : new Set<string>();
  let totalVariants = 0;

  for (const [i, c] of spec.components.entries()) {
    const bind = c.data?.bind;
    if (bind == null) continue;
    const base = `components[${i}].data.bind`;

    // Look up $ref's parameters (handled defensively since parsing can fail even after passing the
    // schema regex).
    let refParams: Record<string, string> | null = null;
    try {
      refParams = parseQueryRef(c.data!.$ref).params;
    } catch {
      refParams = null; // Invalidity of $ref itself is a concern of another path. Only skip param-existence validation here.
    }

    let refVariants = 1;
    for (const [param, binding] of Object.entries(bind)) {
      refVariants *= new Set(binding.values).size;
      const path = `${base}.${param}`;

      if (param.startsWith("_")) {
        issues.push({
          code: "BIND_PARAM_RESERVED",
          severity: "error",
          path,
          message: `bound parameter "${param}" collides with the reserved namespace (leading _)`,
        });
      }

      if (!stateKeys.has(binding.$state)) {
        issues.push({
          code: "BIND_STATE_UNKNOWN",
          severity: "error",
          path: `${path}.$state`,
          message: `state key "${binding.$state}" referenced by a binding has no initial value in spec.state`,
        });
      }

      if (refParams != null) {
        if (!Object.hasOwn(refParams, param)) {
          issues.push({
            code: "BIND_PARAM_MISSING",
            severity: "error",
            path,
            message: `bound parameter "${param}" is missing from the $ref query (no initial variant value)`,
          });
        } else {
          const refValue = refParams[param]!;
          if (!binding.values.includes(refValue)) {
            issues.push({
              code: "BIND_VALUE_INVALID",
              severity: "error",
              path,
              message: `"${param}=${refValue}" in $ref is not among values (the initial variant must be an authorized value)`,
            });
          }
          // If state has an initial value, require the three-way match (compare as strings — query
          // values are strings).
          if (stateKeys.has(binding.$state)) {
            const stateValue = String(spec.state![binding.$state]);
            if (stateValue !== refValue) {
              issues.push({
                code: "BIND_VALUE_INVALID",
                severity: "error",
                path,
                message: `"${param}=${refValue}" in $ref does not match spec.state["${binding.$state}"]="${stateValue}" (initial ref = initial state)`,
              });
            }
          }
        }
      }
    }
    totalVariants += refVariants;
  }

  if (totalVariants > MAX_BIND_VARIANTS) {
    issues.push({
      code: "BIND_VARIANT_LIMIT",
      severity: "error",
      path: "components",
      message: `total bind variants ${totalVariants} exceed the limit ${MAX_BIND_VARIANTS} (caps capability issuance growth)`,
    });
  }
}

export function hasErrors(issues: SpecIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}
