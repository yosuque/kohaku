import { type ComposeContext, type ComposeInput, compose } from "@kohaku-ui/composer";
import {
  type ComponentNode,
  canonicalStringify,
  orderComponents,
  ROOT_COMPONENT_ID,
  type UISpec,
} from "@kohaku-ui/spec-core";

/**
 * Golden Spec regression.
 * Regression test of input Intent → expected Spec. Variation in LLM output is absorbed by normalization:
 * - mask provenance / intent.hash / dataVersion (default)
 * - normalize component IDs to a DFS position basis (references in events / children are renamed consistently)
 */
export interface MatchOptions {
  /** Top-level paths to mask (default: provenance, intent.hash, dataVersion, refVersions) */
  ignore?: ("provenance" | "intent.hash" | "dataVersion" | "refVersions")[];
  /** Normalize IDs to a positional basis (c0, c1, …) before comparing (default true) */
  positionalIds?: boolean;
}

export interface GoldenCase {
  name: string;
  input: ComposeInput;
  expected: UISpec;
  match?: MatchOptions;
}

export interface GoldenCaseResult {
  name: string;
  pass: boolean;
  expected?: string;
  actual?: string;
  error?: string;
  durationMs: number;
}

export interface GoldenReport {
  pass: boolean;
  cases: GoldenCaseResult[];
}

const DEFAULT_IGNORE: NonNullable<MatchOptions["ignore"]> = [
  "provenance",
  "intent.hash",
  "dataVersion",
  "refVersions",
];

/** Returns the canonical-form string for comparison (variation already absorbed). Also usable for a test's diff display. */
export function normalizeForMatch(spec: UISpec, options: MatchOptions = {}): string {
  const ignore = options.ignore ?? DEFAULT_IGNORE;
  let components = spec.components;
  let events = spec.events;

  if (options.positionalIds ?? true) {
    const ordered = orderComponents(components);
    const rename = new Map<string, string>();
    ordered.forEach((c, i) => {
      rename.set(c.id, c.id === ROOT_COMPONENT_ID ? ROOT_COMPONENT_ID : `c${i}`);
    });
    components = ordered.map(
      (c): ComponentNode => ({
        ...c,
        id: rename.get(c.id)!,
        ...(c.children != null ? { children: c.children.map((x) => rename.get(x) ?? x) } : {}),
      }),
    );
    events = events.map((e) => {
      const dot = e.on.indexOf(".");
      const target = rename.get(e.on.slice(0, dot));
      return target != null ? { ...e, on: `${target}${e.on.slice(dot)}` } : e;
    });
  }

  const projected = {
    kohaku: spec.kohaku,
    intent: {
      canonical: spec.intent.canonical,
      params: spec.intent.params,
      ...(ignore.includes("intent.hash") ? {} : { hash: spec.intent.hash }),
    },
    ...(ignore.includes("dataVersion") ? {} : { dataVersion: spec.dataVersion }),
    ...(ignore.includes("refVersions") || spec.refVersions == null ? {} : { refVersions: spec.refVersions }),
    components,
    events,
    ...(ignore.includes("provenance") ? {} : { provenance: spec.provenance }),
  };
  return canonicalStringify(projected);
}

export function specsMatch(actual: UISpec, expected: UISpec, options?: MatchOptions): boolean {
  return normalizeForMatch(actual, options) === normalizeForMatch(expected, options);
}

/** Runs the golden cases through the composer to verify them */
export async function runGolden(cases: GoldenCase[], ctx: ComposeContext): Promise<GoldenReport> {
  const results: GoldenCaseResult[] = [];
  for (const c of cases) {
    const startedAt = Date.now();
    try {
      const { spec } = await compose(c.input, ctx);
      const actual = normalizeForMatch(spec, c.match);
      const expected = normalizeForMatch(c.expected, c.match);
      results.push({
        name: c.name,
        pass: actual === expected,
        ...(actual !== expected ? { actual, expected } : {}),
        durationMs: Date.now() - startedAt,
      });
    } catch (e) {
      results.push({
        name: c.name,
        pass: false,
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - startedAt,
      });
    }
  }
  return { pass: results.every((r) => r.pass), cases: results };
}
