import type { FixedSpecSource } from "@kohaku-ui/composer";
import {
  type CanonicalIntent,
  type ComponentNode,
  type EventBinding,
  type JsonObject,
  type QueryHandle,
  SPEC_VERSION,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { GROUP_AXIS_LABELS, type Region } from "../domain/types.js";
import { groupBy as groupByVocab, region as regionVocab } from "./vocab.js";

/** Output language of the fixed (L0) Specs. Matches the compose-context policy pair. */
export type OutputLang = "en" | "ja";

/**
 * L0 fixed Specs.
 * "App UI is a solidified L1 Spec" — the standard views never go through the LLM at all;
 * this template deterministically generates the Spec (a demonstration of adoption-ladder Step 0).
 *
 * Made L0: quarterly_summary / kpi_overview / records / target_attainment
 * Still L1: trend / by_product (for demoing the LLM's declarative composition)
 * Goes to L2: custom
 *
 * `lang` selects the language of user-visible text (titles, control labels, form copy).
 * The default "en" output is byte-identical to the historical single-language templates; "ja" is
 * wired per-language by compose-context's policy pair (the language rides policy.fixedSpecs, and
 * cache separation rides the policy's generatorVersion — this source itself stays language-passive).
 * Option/cell labels come from the bilingual vocabulary (vocab.ts), the single source for both languages.
 */
export function createFixedSpecs(lang: OutputLang = "en"): FixedSpecSource {
  const builders: Record<string, (intent: CanonicalIntent, refs: QueryHandle[]) => UISpec> = {
    "sales.quarterly_summary": (i, r) => quarterlySummary(i, r, lang),
    "sales.kpi_overview": (i, r) => kpiOverview(i, r, lang),
    "sales.records": (i, r) => recordsView(i, r, lang),
    "sales.target_attainment": (i, r) => targetAttainment(i, r, lang),
  };
  return {
    async lookup(intent) {
      const builder = builders[intent.canonical];
      return builder ?? null;
    },
  };
}

/**
 * Every language-dependent user-visible string (or template function producing one) in the fixed specs,
 * gathered into one lookup table (Replace Conditional with Lookup Table) instead of scattered
 * `lang === "ja" ? … : …` ternaries. The interface forces EN/JA key parity at compile time (same pattern
 * as apps/sample-web/src/i18n/ui.ts). Each builder does `const S = FIXED_SPEC_STRINGS[lang]` and uses
 * `S.xxx` — a static string where the text has no variable part, a function where it does.
 */
interface FixedSpecStrings {
  /** "FY2026" (EN) / "2026年度" (JA) — the fiscal-year fragment, shared by period() and records' scope. */
  fiscalYearLabel(fiscalYear: unknown): string;
  /** Period prefix: "FY2026 Q3" (EN) / "2026年度Q3" (JA). Quarter omitted when absent. */
  period(fiscalYear: unknown, quarter: unknown): string;
  /** "by Region" (EN title fragment) / "地域別" (JA, straight from the groupBy vocabulary). */
  groupByPhrase(groupBy: string): string;
  /** quarterly_summary's heading, e.g. "FY2026 Q3 Sales (by Region)" / "2026年度Q3 売上(地域別)". */
  quarterlySummaryTitle(period: string, groupByPhrase: string, regionSuffix: string): string;
  /** Region cross-filter heading. */
  crossFilterHeading(period: string, groupByPhrase: string): string;
  /** Region cross-filter explanatory hint (presentMarkdown). */
  crossFilterHint: string;
  /** The region control.select's label. */
  regionFilterLabel: string;
  /** Suffix appended after period() when quarter is absent (kpi_overview's full-year scope). */
  fullYearSuffix: string;
  /** kpi_overview's heading, e.g. "FY2026 Q2 Performance Summary". */
  performanceSummaryTitle(scope: string): string;
  /** "All periods" (EN) / "全期間" (JA) — records' scope fragment when fiscalYear is absent. */
  allPeriods: string;
  /** records' heading, e.g. "Sales Records (FY2026 Q3 Japan)". */
  recordsHeading(scope: string): string;
  /** "Add a note" button label. */
  addNoteLabel: string;
  /** Note dialog title. */
  noteDialogTitle: string;
  /** Note dialog description. */
  noteDialogDescription: string;
  /** Note form submit-button label. */
  saveLabel: string;
  /** Note form success message. */
  noteSavedMessage: string;
  /** Note form field label. */
  noteFieldLabel: string;
  /** Note form field placeholder. */
  noteFieldPlaceholder: string;
  /** target_attainment's heading, e.g. "FY2026 Q2 Target Attainment". */
  targetAttainmentTitle(period: string): string;
}

/** EN "FY2026" / JA "2026年度" — kept as named functions so both `fiscalYearLabel` and `period` below can share them. */
function fiscalYearLabelEn(fiscalYear: unknown): string {
  return `FY${fiscalYear}`;
}
function fiscalYearLabelJa(fiscalYear: unknown): string {
  return `${fiscalYear}年度`;
}

const FIXED_SPEC_STRINGS: Record<OutputLang, FixedSpecStrings> = {
  en: {
    fiscalYearLabel: fiscalYearLabelEn,
    period: (fiscalYear, quarter) =>
      quarter != null ? `${fiscalYearLabelEn(fiscalYear)} Q${quarter}` : fiscalYearLabelEn(fiscalYear),
    groupByPhrase: (groupBy) =>
      `by ${GROUP_AXIS_LABELS[groupBy as keyof typeof GROUP_AXIS_LABELS] ?? groupBy}`,
    quarterlySummaryTitle: (period, groupByPhrase, regionSuffix) =>
      `${period} Sales (${groupByPhrase})${regionSuffix}`,
    crossFilterHeading: (period, groupByPhrase) =>
      `${period} Region cross-filter (breakdown ${groupByPhrase})`,
    crossFilterHint:
      "Switching the region re-resolves the chart and table **without a compose round-trip (server round-trip / LLM)** — the effective ref inside the client is swapped via `data.bind`.",
    regionFilterLabel: "Region",
    fullYearSuffix: " Full year",
    performanceSummaryTitle: (scope) => `${scope} Performance Summary`,
    allPeriods: "All periods",
    recordsHeading: (scope) => `Sales Records (${scope})`,
    addNoteLabel: "Add a note",
    noteDialogTitle: "Add a note to these records",
    noteDialogDescription:
      "Writes go part → API directly (with a capability token) and never pass through the LLM's context.",
    saveLabel: "Save",
    noteSavedMessage: "Note saved (the table was refetched at the latest data version).",
    noteFieldLabel: "Note for these records",
    noteFieldPlaceholder: "e.g. Check North America's growth",
    targetAttainmentTitle: (period) => `${period} Target Attainment`,
  },
  ja: {
    fiscalYearLabel: fiscalYearLabelJa,
    period: (fiscalYear, quarter) =>
      quarter != null ? `${fiscalYearLabelJa(fiscalYear)}Q${quarter}` : fiscalYearLabelJa(fiscalYear),
    groupByPhrase: (groupBy) => groupByVocab.label(groupBy, "ja"),
    quarterlySummaryTitle: (period, groupByPhrase, regionSuffix) =>
      `${period} 売上(${groupByPhrase})${regionSuffix}`,
    crossFilterHeading: (period, groupByPhrase) => `${period} 地域クロスフィルター(${groupByPhrase}の内訳)`,
    crossFilterHint:
      "地域を切り替えると、compose の往復(サーバー往復 / LLM)**なし**にチャートと表が再解決されます — `data.bind` によりクライアント内部で実効 ref が差し替わります。",
    regionFilterLabel: "地域",
    fullYearSuffix: " 通年",
    performanceSummaryTitle: (scope) => `${scope} 業績サマリー`,
    allPeriods: "全期間",
    recordsHeading: (scope) => `売上明細(${scope})`,
    addNoteLabel: "メモを追加",
    noteDialogTitle: "この明細にメモを追加",
    noteDialogDescription:
      "書き込みは part → API へ直接(capability トークン付き)行われ、LLM のコンテキストを経由しません。",
    saveLabel: "保存",
    noteSavedMessage: "メモを保存しました(表は最新のデータバージョンで再取得されました)。",
    noteFieldLabel: "この明細へのメモ",
    noteFieldPlaceholder: "例: 北米の成長を確認",
    targetAttainmentTitle: (period) => `${period} 目標達成`,
  },
};

/** "by Region" (EN title fragment) / "地域別" (JA, straight from the groupBy vocabulary). */
function groupByPhrase(groupBy: string, lang: OutputLang): string {
  return FIXED_SPEC_STRINGS[lang].groupByPhrase(groupBy);
}

/** Period prefix: "FY2026 Q3" (EN) / "2026年度Q3" (JA). Quarter omitted when absent. */
function period(p: JsonObject, lang: OutputLang): string {
  return FIXED_SPEC_STRINGS[lang].period(p["fiscalYear"], p["quarter"]);
}

function regionSuffix(params: JsonObject, lang: OutputLang): string {
  const region = params["region"] as Region | undefined;
  return region != null ? ` — ${regionVocab.label(region, lang)}` : "";
}

/** Plain {value,label} options in the requested language (the overlay map itself is not embedded in Specs). */
function regionOptions(lang: OutputLang): { value: string; label: string }[] {
  return regionVocab.options().map((o) => ({ value: o.value, label: regionVocab.label(o.value, lang) }));
}

function quarterlySummary(intent: CanonicalIntent, refs: QueryHandle[], lang: OutputLang): UISpec {
  const p = intent.params;
  const groupBy = String(p["groupBy"] ?? "region");
  const title = FIXED_SPEC_STRINGS[lang].quarterlySummaryTitle(
    period(p, lang),
    groupByPhrase(groupBy, lang),
    regionSuffix(p, lang),
  );
  // Assumes catalog.ts's sales.quarterly_summary.toQueries returns only the single [summary].
  const ref = refs[0]!.uri;

  // Cross-filter demonstration (A1 two-way binding): when region is specified, wire up control.select and
  // data.bind(region) and perform region switching by in-client re-resolution without a compose round-trip.
  // The initial variant ($ref) is the canonical form including region = the output of toQueries, so freshness can be reconciled via refVersions.
  const region = p["region"] as Region | undefined;
  if (region != null) return crossFilterSummary(intent, ref, groupBy, region, lang);

  const components: ComponentNode[] = [
    {
      id: "root",
      type: "layout.stack",
      props: { direction: "vertical", gap: "md" },
      children: ["t", "c", "g"],
    },
    { id: "t", type: "text.heading", props: { level: 2, text: title } },
    {
      id: "c",
      type: "presentChart",
      props: { kind: "bar", x: groupBy, y: "revenue" },
      data: { $ref: ref },
    },
    { id: "g", type: "presentSpreadsheet", props: { editable: false }, data: { $ref: ref } },
  ];
  const events: EventBinding[] =
    groupBy === "region"
      ? [{ on: "g.rowClick", emit: "intent.patch", payload: { drilldown: "$row.region" } }]
      : [];
  return template(intent, components, events);
}

/**
 * L0 fixed Spec for the region cross-filter (A1 two-way binding demonstration).
 * Wires up a chart/table with control.select(region) + data.bind(region), performing region switching
 * without a compose round-trip (in-client effective-ref re-resolution). $ref is the initial variant including region.
 * The bind's values are identical to catalog's region enum (vocab's region.bindValues()), which is the source of
 * truth for capability variant enumeration. The value set is taken from the single vocabulary source and holds no hand-written array.
 */
function crossFilterSummary(
  intent: CanonicalIntent,
  ref: string,
  groupBy: string,
  region: Region,
  lang: OutputLang,
): UISpec {
  const S = FIXED_SPEC_STRINGS[lang];
  const p = intent.params;
  // Binding that replaces the region parameter with $state.region. values = the sole source of truth for authorization and enumeration
  // (vocab's region.bindValues() = the same set as catalog enum).
  const regionBind = { region: { $state: "region", values: regionVocab.bindValues() } };
  const heading = S.crossFilterHeading(period(p, lang), groupByPhrase(groupBy, lang));
  const hint = S.crossFilterHint;
  const components: ComponentNode[] = [
    {
      id: "root",
      type: "layout.stack",
      props: { direction: "vertical", gap: "md" },
      children: ["t", "hint", "filter", "c", "g"],
    },
    {
      id: "t",
      type: "text.heading",
      props: { level: 2, text: heading },
    },
    {
      id: "hint",
      type: "presentMarkdown",
      props: { markdown: hint },
    },
    {
      id: "filter",
      type: "control.select",
      props: {
        label: S.regionFilterLabel,
        value: region,
        options: regionOptions(lang),
      },
    },
    {
      id: "c",
      type: "presentChart",
      props: { kind: "bar", x: groupBy, y: "revenue" },
      data: { $ref: ref, bind: regionBind },
    },
    {
      id: "g",
      type: "presentSpreadsheet",
      props: { editable: false },
      data: { $ref: ref, bind: regionBind },
    },
  ];
  // filter.change -> state.set(region). Completed inside the Renderer (nothing sent to the server); the bound parts are re-resolved.
  const events: EventBinding[] = [
    { on: "filter.change", emit: "state.set", payload: { key: "region", value: "$value" } },
  ];
  return template(intent, components, events, { region });
}

function kpiOverview(intent: CanonicalIntent, refs: QueryHandle[], lang: OutputLang): UISpec {
  const S = FIXED_SPEC_STRINGS[lang];
  const p = intent.params;
  const scope = p["quarter"] != null ? period(p, lang) : `${period(p, lang)}${S.fullYearSuffix}`;
  const title = S.performanceSummaryTitle(scope);
  const components: ComponentNode[] = [
    {
      id: "root",
      type: "layout.stack",
      props: { direction: "vertical", gap: "md" },
      children: ["t", "grid"],
    },
    { id: "t", type: "text.heading", props: { level: 2, text: title } },
    {
      id: "grid",
      type: "layout.grid",
      props: { columns: 4, gap: "md" },
      children: refs.map((_, i) => `k${i}`),
    },
    ...refs.map(
      (ref, i): ComponentNode => ({
        id: `k${i}`,
        type: "sales.kpiCard",
        props: {},
        data: { $ref: ref.uri },
      }),
    ),
  ];
  return template(intent, components, []);
}

function recordsView(intent: CanonicalIntent, refs: QueryHandle[], lang: OutputLang): UISpec {
  const S = FIXED_SPEC_STRINGS[lang];
  const p = intent.params;
  const scope = [
    p["fiscalYear"] != null ? S.fiscalYearLabel(p["fiscalYear"]) : S.allPeriods,
    p["quarter"] != null ? `Q${p["quarter"]}` : null,
    p["region"] != null ? regionVocab.label(String(p["region"]), lang) : null,
  ]
    .filter(Boolean)
    .join(" ");
  // The $ref of the records. The invalidation target of the write loop (the table below) and the form's payload.refs point to the same reference.
  const ref = refs[0]!.uri;
  // Demonstration of a declarative confirmation flow: press of the "add a note" button -> state.set(noteOpen=true) ->
  // overlay.dialog opens via visibleWhen. No new state mechanism is created for open/close; it is built only from the
  // existing $state + state.set + visibleWhen. The presentForm inside the dialog is the body of the write loop (on submit,
  // annotate advances the data version and actionEffects invalidates the same $ref with the new version -> the table below
  // re-resolves in place without a Spec swap; this is bulk data never passing through the model's context, the reference-passing
  // principle). The dialog's close (Esc / x button / background click) folds noteOpen back via state.set to close itself.
  const components: ComponentNode[] = [
    {
      id: "root",
      type: "layout.stack",
      props: { direction: "vertical", gap: "md" },
      children: ["t", "openNote", "noteDialog", "g"],
    },
    {
      id: "t",
      type: "text.heading",
      props: { level: 2, text: S.recordsHeading(scope) },
    },
    {
      id: "openNote",
      type: "action.button",
      props: { label: S.addNoteLabel, variant: "secondary" },
    },
    {
      id: "noteDialog",
      type: "overlay.dialog",
      props: {
        title: S.noteDialogTitle,
        description: S.noteDialogDescription,
      },
      children: ["noteForm"],
      visibleWhen: { ref: "$state.noteOpen", eq: true },
    },
    {
      id: "noteForm",
      type: "presentForm",
      props: {
        action: "annotate",
        submitLabel: S.saveLabel,
        successMessage: S.noteSavedMessage,
        fields: [
          {
            name: "note",
            type: "text",
            label: S.noteFieldLabel,
            placeholder: S.noteFieldPlaceholder,
            required: true,
          },
        ],
      },
    },
    {
      id: "g",
      type: "presentSpreadsheet",
      props: { editable: false, pageSize: Math.min(Number(p["limit"] ?? 100), 100) },
      data: { $ref: ref },
    },
  ];
  // - openNote.press -> state.set(noteOpen=true): opens the dialog via the button (a declaration-only confirmation flow).
  // - noteDialog.close -> state.set(noteOpen=false): closes itself on Esc / x button / background click.
  // - noteForm.submit -> action.invoke(annotate): payload.note is the single input field ($value.note),
  //   payload.refs is the table's $ref below (actionEffects invalidates this reference with the new data version -> the table re-resolves).
  const events: EventBinding[] = [
    { on: "openNote.press", emit: "state.set", payload: { key: "noteOpen", value: true } },
    { on: "noteDialog.close", emit: "state.set", payload: { key: "noteOpen", value: false } },
    { on: "noteForm.submit", emit: "action.invoke", payload: { note: "$value.note", refs: [ref] } },
  ];
  return template(intent, components, events, { noteOpen: false });
}

function targetAttainment(intent: CanonicalIntent, refs: QueryHandle[], lang: OutputLang): UISpec {
  const p = intent.params;
  // The order of refs depends on the [targets, kpi] returned by catalog.ts's sales.target_attainment.toQueries.
  // refs[0] = per-region targets (chart/table), refs[1] = target_attainment KPI (card).
  // If you change the order in toQueries, refs[0]/refs[1] here must be updated to match.
  const components: ComponentNode[] = [
    {
      id: "root",
      type: "layout.stack",
      props: { direction: "vertical", gap: "md" },
      children: ["t", "k", "c", "g"],
    },
    {
      id: "t",
      type: "text.heading",
      props: {
        level: 2,
        text: FIXED_SPEC_STRINGS[lang].targetAttainmentTitle(period(p, lang)),
      },
    },
    { id: "k", type: "sales.kpiCard", props: {}, data: { $ref: refs[1]!.uri } },
    {
      id: "c",
      type: "presentChart",
      props: { kind: "bar", x: "region", y: ["actual", "target"] },
      data: { $ref: refs[0]!.uri },
    },
    { id: "g", type: "presentSpreadsheet", props: { editable: false }, data: { $ref: refs[0]!.uri } },
  ];
  return template(intent, components, []);
}

/** The composer overwrites the envelope, so only the template's shape is prepared here */
function template(
  intent: CanonicalIntent,
  components: ComponentNode[],
  events: EventBinding[],
  state?: UISpec["state"],
): UISpec {
  return {
    kohaku: SPEC_VERSION,
    intent,
    dataVersion: "template",
    components,
    events,
    // Initial values of client-local state (needed to determine the initial variant of bind / visibleWhen).
    // assembleSpec carries the fixed template's state over into the delivered Spec.
    ...(state != null ? { state } : {}),
    provenance: { tier: "L0", composedBy: "fixed-spec-template", cache: "miss" },
  };
}
