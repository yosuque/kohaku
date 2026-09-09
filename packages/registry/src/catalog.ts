import {
  type CatalogContribution,
  type ComponentNode,
  type EventBinding,
  SANDBOX_HTML_TYPE,
} from "@kohaku-ui/spec-core";
import semver from "semver";
import { catalogFingerprint } from "./fingerprint.js";
import type { CatalogIssue, ComponentDefinition } from "./types.js";

export class CatalogConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogConflictError";
  }
}

export type Catalog = CatalogContribution<ComponentDefinition>;

export interface ValidateAgainstCatalogResult {
  issues: CatalogIssue[];
  /** Normalized nodes with default filling applied while validating props */
  normalized: ComponentNode[];
}

export interface ResolvedCatalog {
  get(type: string): ComponentDefinition | undefined;
  list(): ComponentDefinition[];
  readonly fingerprint: string;
  validate(components: ComponentNode[], events?: EventBinding[]): ValidateAgainstCatalogResult;
}

/**
 * Federated merge: layer product/tenant contributions over the core catalog.
 * New types may be added. An existing type may only be overridden by a higher semver
 * (props backward compatibility is conventionally the catalog author's responsibility).
 */
export function resolveCatalog(core: Catalog, ...contributions: Catalog[]): ResolvedCatalog {
  const byType = new Map<string, ComponentDefinition>();
  for (const def of core.components) {
    if (byType.has(def.type)) {
      throw new CatalogConflictError(`core catalog defines "${def.type}" twice`);
    }
    byType.set(def.type, def);
  }
  for (const contrib of contributions) {
    for (const def of contrib.components) {
      const existing = byType.get(def.type);
      if (existing != null && !semver.gt(def.version, existing.version)) {
        throw new CatalogConflictError(
          `contribution for "${def.type}"@${def.version} does not upgrade existing @${existing.version}`,
        );
      }
      byType.set(def.type, def);
    }
  }

  const fingerprint = catalogFingerprint(
    [...byType.values()].map((d) => ({
      type: d.type,
      version: d.version,
      implementation: d.implementation,
    })),
  );

  return {
    get: (type) => byType.get(type),
    list: () => [...byType.values()],
    fingerprint,
    validate: (components, events = []) => validateAgainstCatalog(byType, components, events),
  };
}

function validateAgainstCatalog(
  byType: Map<string, ComponentDefinition>,
  components: ComponentNode[],
  events: EventBinding[],
): ValidateAgainstCatalogResult {
  const issues: CatalogIssue[] = [];
  const normalized: ComponentNode[] = [];

  for (const node of components) {
    // L2 free-form generated nodes are outside catalog management (the sandbox validates artifact integrity separately)
    if (node.type === SANDBOX_HTML_TYPE) {
      normalized.push(node);
      continue;
    }
    const def = byType.get(node.type);
    if (def == null) {
      issues.push({
        code: "UNKNOWN_TYPE",
        componentId: node.id,
        message: `type "${node.type}" is not in the catalog`,
      });
      normalized.push(node);
      continue;
    }

    const parsed = def.propsSchema.safeParse(node.props);
    if (!parsed.success) {
      issues.push({
        code: "PROPS_INVALID",
        componentId: node.id,
        message: `props do not match ${node.type}@${def.version}: ${parsed.error.message}`,
      });
      normalized.push(node);
    } else {
      normalized.push({
        ...node,
        version: node.version ?? def.version,
        props: parsed.data as ComponentNode["props"],
      });
    }

    if (def.capabilities.data === "required" && node.data == null) {
      issues.push({
        code: "DATA_REQUIRED",
        componentId: node.id,
        message: `type "${node.type}" requires a data $ref`,
      });
    }
    if (def.capabilities.data === "none" && node.data != null) {
      issues.push({
        code: "DATA_FORBIDDEN",
        componentId: node.id,
        message: `type "${node.type}" does not accept data`,
      });
    }
    if (def.capabilities.children === "none" && (node.children?.length ?? 0) > 0) {
      issues.push({
        code: "CHILDREN_NOT_SUPPORTED",
        componentId: node.id,
        message: `type "${node.type}" does not accept children`,
      });
    }
  }

  const nodeById = new Map(components.map((c) => [c.id, c]));
  for (const event of events) {
    // This validate is also called on the raw events of an L1 generation draft (before validation), so
    // eventName can be undefined (no dot). Handle it as it actually is, without a type cast (as).
    // Even for a malformed draft where on is a non-string, report it as an issue rather than
    // letting split raise a TypeError.
    const on: unknown = event.on;
    if (typeof on !== "string") {
      issues.push({
        code: "EVENT_NOT_SUPPORTED",
        componentId: String(on ?? ""),
        message: `event.on is not a string (invalid event binding)`,
      });
      continue;
    }
    const [componentId, eventName] = on.split(".");
    const node = nodeById.get(componentId ?? "");
    if (node == null) continue; // under the jurisdiction of structural validation (UNKNOWN_EVENT_TARGET)
    if (node.type === SANDBOX_HTML_TYPE) continue; // L2 is under the jurisdiction of the bridge allowlist
    const def = byType.get(node.type);
    if (def == null) continue;
    if (eventName == null) {
      // For no dot (e.g. "foo"), avoid the misleading does not emit "undefined" and state it explicitly as a malformed format.
      issues.push({
        code: "EVENT_NOT_SUPPORTED",
        componentId: componentId ?? event.on,
        message: `event.on "${event.on}" is not in componentId.eventName format`,
      });
      continue;
    }
    if (!def.capabilities.events.includes(eventName)) {
      issues.push({
        code: "EVENT_NOT_SUPPORTED",
        componentId,
        message: `type "${node.type}" does not emit "${eventName}" (allowed: ${def.capabilities.events.join(", ") || "none"})`,
      });
    }
  }

  return { issues, normalized };
}
