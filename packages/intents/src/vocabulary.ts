import { z } from "zod";

/**
 * One vocabulary entry: either a single canonical (English) label, or a per-locale label map
 * whose `en` key is the canonical label and every other key is a locale overlay (e.g. `ja`).
 */
export type VocabularyEntry = string | { en: string; [locale: string]: string };

/**
 * Single source for a value set (value + display label). The Zod enum, GUI options,
 * data.bind values, and drilldown label reverse-lookup are all derived from here
 * (consolidating the duplicated declaration of a value set into one place).
 */
export interface Vocabulary {
  readonly name: string;
  /** enum members / bind values (insertion order). */
  readonly values: readonly [string, ...string[]];
  /** value → canonical (English) display label. */
  readonly labels: Readonly<Record<string, string>>;
  /** → Zod catalog params / MCP inputSchema. */
  enum(): z.ZodEnum;
  /** → GUI facet options (value + canonical label + locale overlays when declared). */
  options(): { value: string; label: string; labels?: Record<string, string> }[];
  /**
   * → display (localizing a cell value to its display label). Overlay first, then the
   * canonical label; unknown values are returned as-is.
   */
  label(value: string, locale?: string): string;
  /**
   * → drilldown label→code reverse-lookup. Matches labels of every declared locale
   * (a JA cell label resolves to the same code as its EN counterpart). Unknown labels
   * return undefined.
   */
  reverseLabel(label: string): string | undefined;
  /** → A1 data.bind values (a copy of values). */
  bindValues(): string[];
}

/**
 * Builds a Vocabulary from a label map (code → entry; the insertion order becomes the
 * options / enum order). Passing a domain map such as REGION_LABELS directly makes it
 * the single source for the value set. Plain-string entries stay canonical-only
 * (backward compatible); map entries add locale overlays on top of the `en` canonical.
 */
export function defineVocabulary(name: string, entries: Record<string, VocabularyEntry>): Vocabulary {
  const values = Object.keys(entries);
  if (values.length === 0) {
    throw new Error(`Vocabulary "${name}" requires at least one value`);
  }
  const tuple = values as [string, ...string[]];
  const labels: Record<string, string> = {};
  // value → locale → label, non-en locales only (what options() emits as the overlay).
  const overlays: Record<string, Record<string, string>> = {};
  for (const value of values) {
    const entry = entries[value]!;
    if (typeof entry === "string") {
      labels[value] = entry;
      continue;
    }
    labels[value] = entry.en;
    const overlay: Record<string, string> = {};
    for (const [locale, text] of Object.entries(entry)) {
      if (locale !== "en") overlay[locale] = text;
    }
    if (Object.keys(overlay).length > 0) overlays[value] = overlay;
  }
  // Reverse-lookup label → code across all locales. On duplicate labels, first wins
  // (the first value in insertion order; within a value, canonical before overlays).
  const codeByLabel = new Map<string, string>();
  for (const value of values) {
    const register = (label: string) => {
      if (!codeByLabel.has(label)) codeByLabel.set(label, value);
    };
    register(labels[value]!);
    const overlay = overlays[value];
    if (overlay != null) for (const text of Object.values(overlay)) register(text);
  }
  return {
    name,
    values: tuple,
    labels,
    enum: () => z.enum(tuple),
    options: () =>
      tuple.map((value) => ({
        value,
        label: labels[value]!,
        ...(overlays[value] != null ? { labels: { ...overlays[value] } } : {}),
      })),
    label: (value, locale) => overlays[value]?.[locale ?? "en"] ?? labels[value] ?? value,
    reverseLabel: (label) => codeByLabel.get(label),
    bindValues: () => [...tuple],
  };
}
