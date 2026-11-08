import { type FilterDescriptor, SPEC_VERSION, type UISpec } from "@kohaku-ui/spec-core";
// Relative (not "@kohaku-ui/composer"), same reasoning as cross-language.test.ts: spec does not declare composer.
import { injectFilters } from "../../packages/composer/src/post/inject-filters.js";

/**
 * Inputs for the cross-language golden of composer's `injectFilters` and `policyFingerprint` (the L1 filter
 * injection, ComposePolicy.l1Filters). Shared by the fixture generator and test/cross-language.test.ts; the
 * Python port reads the same inputs back out of the generated fixture, so only the outputs are TS-computed.
 */

const REGION: FilterDescriptor = {
  param: "region",
  queryParam: "geo",
  paths: ["summary"],
  label: "Region",
  options: [
    { value: "japan", label: "Japan" },
    { value: "europe", label: "Europe" },
    { value: "apac", label: "APAC" },
  ],
};
const GROUP_BY: FilterDescriptor = {
  param: "groupBy",
  queryParam: "groupBy",
  paths: ["summary"],
  label: "Group by",
  options: [
    { value: "region", label: "By region" },
    { value: "product", label: "By product" },
  ],
};
const WIDE: FilterDescriptor = {
  param: "region",
  queryParam: "geo",
  paths: ["summary"],
  label: "Region",
  options: Array.from({ length: 130 }, (_, i) => ({
    value: i === 0 ? "europe" : `r${i}`,
    label: `Region ${i}`,
  })),
};

const REF = "query://sales/summary?geo=europe&groupBy=region";

/** A normalized L1-shaped Spec (post normalizeIds): heading + chart + table under a layout.stack root. */
function l1Spec(chartRef: string, tableRef: string = chartRef, rootType = "layout.stack"): UISpec {
  return {
    kohaku: SPEC_VERSION,
    intent: { canonical: "sales.summary", params: { groupBy: "region" }, hash: `sha256:${"ab".repeat(32)}` },
    dataVersion: "sales@v1",
    components: [
      { id: "root", type: rootType, props: {}, children: ["title1", "chart1", "table1"] },
      { id: "title1", type: "text.heading", props: { text: "Sales", level: 2 } },
      { id: "chart1", type: "presentChart", props: { kind: "bar" }, data: { $ref: chartRef } },
      { id: "table1", type: "presentSpreadsheet", props: {}, data: { $ref: tableRef } },
    ],
    events: [{ on: "table1.rowClick", emit: "intent.patch", payload: { drilldown: "$row.region" } }],
    provenance: { tier: "L1", composedBy: "composer", cache: "miss" },
  };
}

export interface InjectFiltersCase {
  name: string;
  spec: UISpec;
  descriptors: FilterDescriptor[];
  /** `ComposePolicy.l1FiltersMaxVariants`; omitted = the default (64). */
  maxVariants?: number;
}

/** REGION with a duplicated option value (first wins). */
const REGION_DUP_OPTIONS: FilterDescriptor = {
  ...REGION,
  options: [
    { value: "europe", label: "Europe" },
    { value: "japan", label: "Japan" },
    { value: "europe", label: "Europe again" },
  ],
};

/** 32 options x 2 data components = 64 variants (the default cap), 33 x 2 = 66 (over it). */
function regionWithOptions(n: number): FilterDescriptor {
  return {
    ...REGION,
    options: Array.from({ length: n }, (_, i) => ({
      value: i === 0 ? "europe" : `r${i}`,
      label: `Region ${i}`,
    })),
  };
}

const withOwnBind: UISpec = (() => {
  const base = l1Spec(REF);
  return {
    ...base,
    state: { own: "europe" },
    components: base.components.map((c) =>
      c.id === "table1"
        ? { ...c, data: { $ref: REF, bind: { geo: { $state: "own", values: ["europe", "japan"] } } } }
        : c,
    ),
  };
})();

export const INJECT_FILTERS_CASES: InjectFiltersCase[] = [
  { name: "one filter, two data components", spec: l1Spec(REF), descriptors: [REGION] },
  { name: "two filters combine into a Cartesian bind", spec: l1Spec(REF), descriptors: [GROUP_BY, REGION] },
  {
    name: "components with different refs share one control",
    spec: l1Spec(REF, "query://sales/summary?geo=europe&groupBy=product"),
    descriptors: [REGION],
  },
  {
    name: "a current value outside the options is not injected, the other filter is",
    spec: l1Spec("query://sales/summary?geo=mars&groupBy=region"),
    descriptors: [REGION, GROUP_BY],
  },
  {
    name: "no descriptor matches a $ref query param",
    spec: l1Spec("query://sales/summary?groupBy=region"),
    descriptors: [REGION],
  },
  { name: "empty descriptor list", spec: l1Spec(REF), descriptors: [] },
  { name: "variant limit abandons the whole injection", spec: l1Spec(REF), descriptors: [WIDE] },
  {
    name: "a root that cannot host controls is invalid",
    spec: l1Spec(REF, REF, "layout.tabs"),
    descriptors: [REGION],
  },
  {
    name: "the data components disagree on the current value",
    spec: l1Spec(REF, "query://sales/summary?geo=japan&groupBy=region"),
    descriptors: [REGION],
  },
  {
    name: "an existing state key collides",
    spec: { ...l1Spec(REF), state: { region: "japan" } },
    descriptors: [REGION],
  },
  {
    name: "a component on another path is not bound and does not count",
    spec: l1Spec(REF, "query://sales/trend?geo=europe&groupBy=region"),
    descriptors: [REGION],
  },
  {
    name: "no data component reads a path the descriptors govern",
    spec: l1Spec(REF),
    descriptors: [
      { ...REGION, paths: ["trend"] },
      { ...GROUP_BY, paths: [] },
    ],
  },
  {
    name: "a component already bound on the query param is left alone",
    spec: withOwnBind,
    descriptors: [REGION],
  },
  {
    name: "a reserved _-prefixed queryParam is skipped",
    spec: l1Spec("query://sales/summary?_limit=europe"),
    descriptors: [{ ...REGION, queryParam: "_limit" }],
  },
  {
    name: "duplicate option values are de-duplicated, first wins",
    spec: l1Spec(REF),
    descriptors: [REGION_DUP_OPTIONS],
  },
  {
    name: "a second descriptor for the same param, and one rebinding the same queryParam, are ignored",
    spec: l1Spec(REF),
    descriptors: [REGION, { ...REGION, label: "Other" }, { ...GROUP_BY, param: "area", queryParam: "geo" }],
  },
  {
    name: "a Spec that cannot carry state / bind (kohaku 0.1) fails validation",
    spec: { ...l1Spec(REF), kohaku: "0.1" },
    descriptors: [REGION],
  },
  {
    name: "idempotency: a second pass over an already-injected Spec injects nothing",
    spec: injectFilters(l1Spec(REF), [REGION, GROUP_BY]).spec,
    descriptors: [REGION, GROUP_BY],
  },
  { name: "64 variants fit the default cap", spec: l1Spec(REF), descriptors: [regionWithOptions(32)] },
  { name: "66 variants exceed the default cap", spec: l1Spec(REF), descriptors: [regionWithOptions(33)] },
  {
    name: "an explicit cap admits 66 variants",
    spec: l1Spec(REF),
    descriptors: [regionWithOptions(33)],
    maxVariants: 66,
  },
  { name: "an explicit cap rejects 6 variants", spec: l1Spec(REF), descriptors: [REGION], maxVariants: 5 },
];

export interface PolicyFingerprintCase {
  name: string;
  /** The JSON-expressible subset of ComposePolicy that both languages can build from the fixture. */
  policy: {
    outputLanguage?: string;
    refConstraint?: "schema" | "validate";
    allowL2?: boolean;
    effort?: { l1?: "low" | "medium" | "high"; l2?: "low" | "medium" | "high" };
    l1Filters?: boolean;
    l1FiltersMaxVariants?: number;
  };
  /** The descriptors `describeFilters` returned for the compose; their hash is the fingerprint's third input. */
  descriptors?: FilterDescriptor[];
}

export const POLICY_FINGERPRINT_CASES: PolicyFingerprintCase[] = [
  { name: "empty policy", policy: {} },
  { name: "l1Filters false is the default", policy: { l1Filters: false } },
  { name: "l1Filters true", policy: { l1Filters: true } },
  { name: "l1Filters true with an output language", policy: { outputLanguage: "Japanese", l1Filters: true } },
  { name: "output language alone", policy: { outputLanguage: "Japanese" } },
  { name: "allowL2 true with l1Filters true", policy: { allowL2: true, l1Filters: true } },
  { name: "l1FiltersMaxVariants 64 is the default", policy: { l1Filters: true, l1FiltersMaxVariants: 64 } },
  { name: "l1FiltersMaxVariants 32", policy: { l1Filters: true, l1FiltersMaxVariants: 32 } },
  { name: "l1FiltersMaxVariants without l1Filters is ignored", policy: { l1FiltersMaxVariants: 32 } },
  { name: "l1Filters true with descriptors", policy: { l1Filters: true }, descriptors: [REGION] },
  {
    name: "l1Filters true with other descriptors",
    policy: { l1Filters: true },
    descriptors: [REGION, GROUP_BY],
  },
  {
    name: "l1Filters true with the same options relabelled",
    policy: { l1Filters: true },
    descriptors: [{ ...REGION, label: "地域" }],
  },
  {
    name: "l1Filters false ignores descriptors",
    policy: { l1Filters: false },
    descriptors: [REGION],
  },
  {
    name: "refConstraint validate with effort",
    policy: { refConstraint: "validate", effort: { l1: "low" } },
  },
];
