import { type ComponentNode, SANDBOX_HTML_TYPE, type UISpec } from "@kohaku-ui/spec-core";
import semver from "semver";
import type { ResolvedCatalog } from "./catalog.js";
import type { SurfaceCapabilities } from "./types.js";

export interface Downgrade {
  id: string;
  from: string;
  to: string;
  reason: string;
}

const TERMINAL_FALLBACK = "presentMarkdown";

/**
 * Capability negotiation. Downgrades parts the surface does not implement along the definition-side
 * fallback chain. The terminal is presentMarkdown (a text fallback).
 */
export function negotiate(
  spec: UISpec,
  catalog: ResolvedCatalog,
  surface: SurfaceCapabilities,
): { spec: UISpec; downgrades: Downgrade[] } {
  const downgrades: Downgrade[] = [];
  // Pin the catalog version on downgraded nodes too (a missing version causes inconsistency on re-validation / re-negotiation).
  const ver = (type: string): { version?: string } => {
    const v = catalog.get(type)?.version;
    return v != null ? { version: v } : {};
  };

  const components = spec.components.map((node): ComponentNode => {
    if (node.type === SANDBOX_HTML_TYPE) {
      if ((surface.maxTier ?? "L2") === "L2") return node;
      downgrades.push({
        id: node.id,
        from: node.type,
        to: TERMINAL_FALLBACK,
        reason: `surface does not allow tier L2`,
      });
      return {
        id: node.id,
        type: TERMINAL_FALLBACK,
        ...ver(TERMINAL_FALLBACK),
        props: { markdown: "(Free-form generated components cannot be displayed on this surface)" },
      };
    }

    if (supports(surface, node.type, node.version)) return node;

    // Follow the fallback chain
    let current = node;
    const visited = new Set<string>([node.type]);
    for (;;) {
      const def = catalog.get(current.type);
      const fb = def?.fallback;
      if (fb == null || visited.has(fb.type)) {
        if (current.type !== TERMINAL_FALLBACK) {
          downgrades.push({
            id: node.id,
            from: node.type,
            to: TERMINAL_FALLBACK,
            reason: `surface lacks "${node.type}" and no usable fallback chain`,
          });
          return {
            id: node.id,
            type: TERMINAL_FALLBACK,
            ...ver(TERMINAL_FALLBACK),
            props: { markdown: `(Component ${node.type} is not available on this surface)` },
          };
        }
        return current;
      }
      visited.add(fb.type);
      const next: ComponentNode = {
        id: current.id,
        type: fb.type,
        ...ver(fb.type),
        props: fb.mapProps(current.props),
        // If the downgrade target does not accept children (capabilities.children === "none"), drop
        // the children. Symmetric with the data downgrade check (next line). Leaving children on a
        // children:"none" part would produce CHILDREN_NOT_SUPPORTED in structural validation.
        ...(current.children != null && catalog.get(fb.type)?.capabilities.children !== "none"
          ? { children: current.children }
          : {}),
        ...(current.data != null && catalog.get(fb.type)?.capabilities.data !== "none"
          ? { data: current.data }
          : {}),
      };
      if (supports(surface, fb.type, catalog.get(fb.type)?.version)) {
        downgrades.push({
          id: node.id,
          from: node.type,
          to: fb.type,
          reason: `surface lacks "${current.type}"`,
        });
        return next;
      }
      current = next;
    }
  });

  if (downgrades.length === 0) return { spec, downgrades };

  return {
    spec: {
      ...spec,
      components,
      provenance: {
        ...spec.provenance,
        // If an existing fallback is present (e.g. "generation" from a generation failure), negotiation
        // overwrites it last-writer-wins (a simplification of one downgrade trace per Spec; recording
        // multiple kinds together = turning it into an array is future work).
        fallback: {
          from: downgrades.map((d) => `${d.id}:${d.from}`).join(","),
          reason: "capability negotiation",
          kind: "negotiation",
        },
      },
    },
    downgrades,
  };
}

/**
 * Memoizes the result of semver.satisfies (performance). The key space is bounded, coming from the
 * catalog (part version) × surface (supports range), but to avoid unbounded growth in a long-lived
 * process it is cleared once a maximum count is reached.
 */
const SATISFIES_CACHE_MAX = 1000;
const satisfiesCache = new Map<string, boolean>();

function satisfiesMemo(version: string, range: string): boolean {
  const key = `${version}|${range}`;
  const cached = satisfiesCache.get(key);
  if (cached !== undefined) return cached;
  const result = semver.satisfies(version, range);
  // On reaching the limit, clear everything naively (an LRU is not needed; the key space is bounded and rarely reached).
  if (satisfiesCache.size >= SATISFIES_CACHE_MAX) satisfiesCache.clear();
  satisfiesCache.set(key, result);
  return result;
}

function supports(surface: SurfaceCapabilities, type: string, version: string | undefined): boolean {
  const range = surface.supports[type];
  if (range == null) return false;
  if (version == null) return true;
  return satisfiesMemo(version, range);
}
