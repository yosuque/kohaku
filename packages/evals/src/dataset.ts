import {
  type CanonicalIntent,
  type ComponentNode,
  canonicalStringify,
  type EventBinding,
  type FixationRecord,
  type UISpec,
} from "@kohaku-ui/spec-core";
import type { ColumnMeta } from "./judge.js";

/**
 * Distillation dataset.
 *
 * Research on catalog-constrained declarative UI generation shows small models close much of the gap to
 * frontier models when trained/prompted on this kind of constrained output. A human-approved fixation
 * (L0, `FixationRecord.pinnedSpec`) is the best teacher example available: it is exactly the
 * {components, events} pair a distilled model should learn to reproduce for a given Intent, already
 * vetted by a human approver. Golden Specs (packages/evals's own regression fixtures) are the same shape
 * of teacher example without the human-approval step, useful as supplementary training data.
 *
 * Exported as JSONL (one line per Spec) so it composes with the usual fine-tuning / distillation tooling
 * (streaming read, `wc -l`, `shuf`, …) without a custom parser.
 */

/** One distillation-dataset record: the LLM's declarative-generation input/output pair. */
export interface DistillationRecord {
  intent: { canonical: string; params: Record<string, unknown> };
  /** The set of $refs the Spec's components read from (deduplicated, first-occurrence order). */
  refs: string[];
  /** Optional column metadata for the Intent's data shape (from `describeShape`; omitted when not supplied). */
  shape?: ColumnMeta[];
  /**
   * The LLM's actual output range only: `components` + `events`. Deliberately excludes `kohaku` (the
   * protocol-envelope version), `provenance`, and `dataVersion` — composer fills all three in around the
   * model's output, so a distillation target that included them would teach a distilled model to imitate
   * infra plumbing it never actually produces, rather than the declarative UI itself.
   */
  target: { components: ComponentNode[]; events: EventBinding[] };
  source: "fixation" | "golden";
  /**
   * `tenant` / `catalogFingerprint` are populated from the FixationRecord for `source: "fixation"` rows
   * (omitted when the record predates that field, exactly like `FixationRecordSchema`'s own optionality).
   * Golden-derived rows keep an empty `meta` (golden Specs carry no tenant or fixation-time fingerprint).
   * Without `tenant`, a dataset spanning several tenants (the on-disk `fixations.json` legitimately holds
   * one record per (tenant, intentHash), see storage-port.ts) cannot be told apart after export; without
   * `catalogFingerprint`, there is no record of which catalog generation `target`'s component
   * types/versions were valid for.
   */
  meta: { fixatedAt?: string; structureHash?: string; tenant?: string; catalogFingerprint?: string };
}

export interface ExportDistillationDatasetInput {
  /** Human-approved L1→L0 fixations (validated FixationRecordSchema data; see @kohaku-ui/spec-core). */
  fixations: FixationRecord[];
  /** Optional supplementary teacher examples (e.g. golden regression fixtures' `expected` Specs). */
  golden?: UISpec[];
}

export interface ExportDistillationDatasetOptions {
  /**
   * Optional per-record column-metadata lookup (typically backed by the domain's resultShape). Return
   * undefined to omit the `shape` field for that record.
   */
  describeShape?: (intent: CanonicalIntent) => ColumnMeta[] | undefined;
  /**
   * Restrict the export to fixations whose `tenant` matches this id (`golden` Specs carry no tenant and
   * are always included regardless of this filter). Omitted = every tenant present in `input.fixations`
   * is included in one JSONL — the on-disk `fixations.json` snapshot legitimately holds records for
   * several tenants side by side (keyed `${tenant} ${intentHash}`; see storage-port.ts), so without this
   * filter their approved structures land unmarked in one file unless `meta.tenant` is inspected per line.
   */
  tenant?: string;
}

/** Extracts the set of $refs a Spec's components read from (deduplicated, first-occurrence order). */
function refsOf(components: ComponentNode[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of components) {
    const ref = c.data?.$ref;
    if (ref != null && !seen.has(ref)) {
      seen.add(ref);
      out.push(ref);
    }
  }
  return out;
}

/**
 * Projects a ColumnMeta down to exactly `{name, type?, description?}`. `ColumnMeta` is structurally typed
 * (callers commonly pass an object shaped by the domain's own resultShape type), so without this
 * projection any extra keys that object happens to carry would leak into the dataset verbatim, breaking
 * the claim that TypeScript's and Python's `.data` (which already projects to these three keys) produce
 * the same dataset.
 */
function projectColumnMeta(shape: ColumnMeta[]): ColumnMeta[] {
  return shape.map((c) => ({
    name: c.name,
    ...(c.type !== undefined ? { type: c.type } : {}),
    ...(c.description !== undefined ? { description: c.description } : {}),
  }));
}

function shapeField(shape: ColumnMeta[] | undefined): { shape: ColumnMeta[] } | Record<string, never> {
  return shape != null ? { shape: projectColumnMeta(shape) } : {};
}

/** Explicit tie-break order for entries that share the same sort key (see the sort below). */
function sourceOrder(source: DistillationRecord["source"]): 0 | 1 {
  return source === "fixation" ? 0 : 1;
}

/**
 * Exports human-approved fixations (and optionally golden Specs) as a JSONL distillation dataset: one
 * canonical-JSON line per Spec.
 *
 * Deterministic order: entries are sorted by `(intentHash, source)` ascending (`FixationRecord.intentHash`
 * for fixation entries, `spec.intent.hash` for golden entries; a `fixation` entry sorts before a `golden`
 * entry that shares the same intentHash — an explicit tie-break rather than relying on sort stability),
 * and each line is serialized with `canonicalStringify` (deep key-sorted, byte-identical across
 * languages). Re-running the export on the same input therefore reproduces byte-identical output — this
 * is also what pins the TS/Python cross-language golden (spec/scripts/generate-cross-language-fixtures.ts).
 *
 * Returns the empty string for an empty input (no trailing newline); otherwise every line, including the
 * last, ends with `\n`.
 */
export function exportDistillationDataset(
  input: ExportDistillationDatasetInput,
  options: ExportDistillationDatasetOptions = {},
): string {
  const keyed: { key: string; record: DistillationRecord }[] = [];

  const fixations =
    options.tenant != null ? input.fixations.filter((r) => r.tenant === options.tenant) : input.fixations;

  for (const record of fixations) {
    const spec = record.pinnedSpec;
    keyed.push({
      key: record.intentHash,
      record: {
        intent: { canonical: spec.intent.canonical, params: spec.intent.params },
        refs: refsOf(spec.components),
        ...shapeField(options.describeShape?.(spec.intent)),
        target: { components: spec.components, events: spec.events },
        source: "fixation",
        meta: {
          fixatedAt: record.fixatedAt,
          structureHash: record.structureHash,
          tenant: record.tenant,
          catalogFingerprint: record.catalogFingerprint,
        },
      },
    });
  }

  for (const spec of input.golden ?? []) {
    keyed.push({
      key: spec.intent.hash,
      record: {
        intent: { canonical: spec.intent.canonical, params: spec.intent.params },
        refs: refsOf(spec.components),
        ...shapeField(options.describeShape?.(spec.intent)),
        target: { components: spec.components, events: spec.events },
        source: "golden",
        meta: {},
      },
    });
  }

  keyed.sort((a, b) => {
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return sourceOrder(a.record.source) - sourceOrder(b.record.source);
  });
  const lines = keyed.map(({ record }) => canonicalStringify(record));
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
