import { CLI_VERSION } from "../version.js";
import type { DatasetProfile } from "./infer.js";
import { humanize } from "./infer.js";
import type { Row } from "./readers.js";
import {
  APP_TEMPLATE,
  DEV_SCRIPT_TEMPLATE,
  DOMAIN_PORT_TEMPLATE,
  ENV_EXAMPLE_TEMPLATE,
  FIXED_SPECS_TEMPLATE,
  GITIGNORE_TEMPLATE,
  GOLDEN_TEST_TEMPLATE_INIT,
  INDEX_HTML_TEMPLATE,
  MAIN_TEMPLATE,
  TSCONFIG_TEMPLATE,
  VITE_CONFIG_TEMPLATE,
  WEB_MAIN_TEMPLATE,
} from "./templates.js";
import { EXTERNAL_VERSIONS } from "./versions.js";

export interface ProjectFile {
  path: string;
  content: string;
}

const KOHAKU_RUNTIME = [
  "authz-hmac",
  "client",
  "composer",
  "data-binding",
  "evals",
  "host-rest",
  "intents",
  "llm",
  "registry",
  "renderer-core",
  "renderer-react",
  "semantic-llm",
  "spec-core",
  "storage-memory",
];

function q(s: string): string {
  return JSON.stringify(s);
}

// Every top-level identifier `renderIntents` itself introduces into the generated `server/intents.ts`:
// the six facet-vocabulary bindings, plus the module's own imports and other exported consts. A
// dimension column whose slug collides with one of these would otherwise produce a duplicate-identifier
// compile error in the generated project (e.g. a column literally named "z" clashing with the zod import).
const RESERVED_BINDINGS = [
  "metric",
  "agg",
  "groupBy",
  "granularity",
  "filters",
  "period",
  "z",
  "SOURCE",
  "INTENT_DEFINITIONS",
  "defineIntent",
  "defineVocabulary",
];

function vocabName(column: string): string {
  return RESERVED_BINDINGS.includes(column) ? `${column}Vocab` : column;
}

export function renderIntents(profile: DatasetProfile): string {
  const src = profile.source;
  const dims = profile.dimensions;
  const hasTime = profile.time != null;
  const lines: string[] = [];
  lines.push(
    'import { defineIntent, defineVocabulary, type IntentBuilder } from "@kohaku-ui/intents";',
    'import { z } from "zod";',
    "",
  );
  lines.push(`export const SOURCE = ${q(src)};`, "");
  lines.push(
    "// Vocabularies (value set + label) inferred from the categorical columns. Edit labels freely; values must match the data.",
  );
  for (const d of dims) {
    lines.push(`export const ${vocabName(d.name)} = defineVocabulary(${q(d.name)}, {`);
    for (const v of d.values ?? [])
      lines.push(`  ${/^[a-z_][a-z0-9_]*$/i.test(v) ? v : q(v)}: ${q(humanize(v))},`);
    lines.push("});");
  }
  lines.push("");
  lines.push('export const metric = defineVocabulary("metric", {');
  for (const m of profile.measures) lines.push(`  ${m.name}: ${q(humanize(m.name))},`);
  lines.push('  count: "Row count",', "});");
  lines.push('export const agg = defineVocabulary("agg", { sum: "Sum", avg: "Average" });');
  lines.push('export const groupBy = defineVocabulary("groupBy", {');
  for (const d of dims) lines.push(`  ${d.name}: ${q(`By ${humanize(d.name).toLowerCase()}`)},`);
  lines.push("});");
  if (hasTime)
    lines.push(
      'export const granularity = defineVocabulary("granularity", { month: "Monthly", quarter: "Quarterly", year: "Yearly" });',
    );
  lines.push("");
  lines.push("const filters = {");
  for (const d of dims) lines.push(`  ${d.name}: ${vocabName(d.name)}.enum().optional(),`);
  lines.push("};");
  if (hasTime) lines.push("const period = { from: z.string().optional(), to: z.string().optional() };");
  lines.push("");
  const filterFacets = dims.map(
    (d) =>
      `      { param: ${q(d.name)}, label: ${q(humanize(d.name))}, options: ${vocabName(d.name)}, emptyLabel: "All" },`,
  );
  const filterMap = dims.map((d) => `${d.name}: ${q(d.name)}`).join(", ");
  const periodMap = hasTime ? ', from: "from", to: "to"' : "";
  const defaultMetric = profile.measures[0]?.name ?? "count";
  const firstDim = dims[0]!.name;
  const dimList = dims.map((d) => humanize(d.name).toLowerCase()).join(" / ");
  const measureList = [...profile.measures.map((m) => humanize(m.name).toLowerCase()), "the row count"].join(
    ", ",
  );

  lines.push("export const INTENT_DEFINITIONS: IntentBuilder[] = [");
  lines.push("  defineIntent({");
  lines.push(`    canonical: ${q(`${src}.summary`)},`);
  lines.push(
    `    description: ${q(`Aggregate ${measureList} by ${dimList} (sum or average), optionally filtered`)},`,
  );
  lines.push("    source: SOURCE,", '    viewLabel: "Summary",');
  lines.push(
    `    params: z.object({ metric: metric.enum().default(${q(defaultMetric)}), agg: agg.enum().default("sum"), groupBy: groupBy.enum().default(${q(firstDim)}), ...filters${hasTime ? ", ...period" : ""} }),`,
  );
  lines.push(
    `    examples: [${q(`${humanize(defaultMetric)} by ${humanize(firstDim).toLowerCase()}`)}, ${q(`Average ${humanize(defaultMetric).toLowerCase()} by ${humanize(dims[dims.length - 1]!.name).toLowerCase()}`)}, ${q(`How many rows per ${humanize(firstDim).toLowerCase()}?`)}],`,
  );
  lines.push(
    "    facets: [",
    '      { param: "metric", label: "Metric", options: metric },',
    '      { param: "agg", label: "Aggregation", options: agg },',
    '      { param: "groupBy", label: "Group by", options: groupBy },',
    ...filterFacets,
    "    ],",
  );
  lines.push(
    `    queries: [{ path: "summary", paramMap: { metric: "metric", agg: "agg", groupBy: "groupBy", ${filterMap}${periodMap} } }],`,
  );
  lines.push("  }),");
  if (hasTime) {
    lines.push("  defineIntent({");
    lines.push(`    canonical: ${q(`${src}.trend`)},`);
    lines.push(
      `    description: ${q(`Show how ${measureList} changes over time (monthly / quarterly / yearly), optionally filtered`)},`,
    );
    lines.push("    source: SOURCE,", '    viewLabel: "Trend",');
    lines.push(
      `    params: z.object({ metric: metric.enum().default(${q(defaultMetric)}), agg: agg.enum().default("sum"), granularity: granularity.enum().default("month"), ...filters, ...period }),`,
    );
    lines.push(
      `    examples: [${q(`Monthly ${humanize(defaultMetric).toLowerCase()} trend`)}, ${q(`Quarterly ${humanize(defaultMetric).toLowerCase()}`)}, ${q("How did it change over the year?")}],`,
    );
    lines.push(
      "    facets: [",
      '      { param: "metric", label: "Metric", options: metric },',
      '      { param: "granularity", label: "Granularity", options: granularity },',
      ...filterFacets,
      "    ],",
    );
    lines.push(
      `    queries: [{ path: "trend", paramMap: { metric: "metric", agg: "agg", granularity: "granularity", ${filterMap}${periodMap} } }],`,
    );
    lines.push("  }),");
  }
  lines.push("  defineIntent({");
  lines.push(`    canonical: ${q(`${src}.records`)},`);
  lines.push('    description: "List the raw rows, optionally filtered",');
  lines.push("    source: SOURCE,", '    viewLabel: "Records",');
  lines.push(
    `    params: z.object({ ...filters${hasTime ? ", ...period" : ""}, limit: z.coerce.number().int().min(1).max(500).default(100) }),`,
  );
  lines.push('    examples: ["Show me the rows", "List the records"],');
  lines.push("    facets: [", ...filterFacets, "    ],");
  lines.push(`    queries: [{ path: "records", paramMap: { ${filterMap}${periodMap}, limit: "limit" } }],`);
  lines.push("  }),");
  lines.push("];", "");
  return lines.join("\n");
}

export function renderDataset(profile: DatasetProfile): string {
  return [
    'import { createHash } from "node:crypto";',
    'import { readFileSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    "export type Cell = string | number | boolean | null;",
    "export type Row = Record<string, Cell>;",
    "",
    "export interface Columns {",
    "  source: string;",
    "  dimensions: readonly string[];",
    "  measures: readonly string[];",
    "  time: string | null;",
    "}",
    "",
    "/** Column roles inferred by `kohaku init`. The intents and the domain port read this; edit it when the data changes. */",
    "export const COLUMNS: Columns = {",
    `  source: ${q(profile.source)},`,
    `  dimensions: [${profile.dimensions.map((d) => q(d.name)).join(", ")}],`,
    `  measures: [${profile.measures.map((m) => q(m.name)).join(", ")}],`,
    `  time: ${profile.time != null ? q(profile.time.name) : "null"},`,
    "};",
    "",
    `const DATA_PATH = join(dirname(fileURLToPath(import.meta.url)), "../data/${profile.source}.json");`,
    'const raw = readFileSync(DATA_PATH, "utf8");',
    "export const ROWS: Row[] = JSON.parse(raw) as Row[];",
    "/** Changes whenever the data file changes, so a cached Spec composed for old data is re-validated (STALE_VERSION). */",
    `export const DATA_VERSION = \`${profile.source}@\${createHash("sha256").update(raw).digest("hex").slice(0, 12)}\`;`,
    "",
  ].join("\n");
}

export function renderFixedSpecs(profile: DatasetProfile): string {
  return FIXED_SPECS_TEMPLATE.replaceAll("__SOURCE__", profile.source);
}

export function renderPackageJson(name: string, profile: DatasetProfile): string {
  const dependencies: Record<string, string> = {};
  for (const pkg of KOHAKU_RUNTIME) dependencies[`@kohaku-ui/${pkg}`] = `^${CLI_VERSION}`;
  for (const pkg of [
    "hono",
    "@hono/node-server",
    "zod",
    "react",
    "react-dom",
    "@ai-sdk/anthropic",
    "@ai-sdk/openai-compatible",
  ])
    dependencies[pkg] = EXTERNAL_VERSIONS[pkg]!;
  const devDependencies: Record<string, string> = {};
  for (const pkg of [
    "@types/node",
    "@types/react",
    "@types/react-dom",
    "@vitejs/plugin-react",
    "tsx",
    "typescript",
    "vite",
    "vitest",
  ])
    devDependencies[pkg] = EXTERNAL_VERSIONS[pkg]!;
  return `${JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      description: `kohaku app generated from ${profile.source} (${profile.rowCount} rows)`,
      scripts: {
        dev: "node dev.mjs",
        "dev:api": "tsx watch server/main.ts",
        "dev:web": "vite",
        typecheck: "tsc --noEmit",
        test: "vitest run",
      },
      engines: { node: ">=22" },
      dependencies: Object.fromEntries(Object.entries(dependencies).sort()),
      devDependencies: Object.fromEntries(Object.entries(devDependencies).sort()),
    },
    null,
    2,
  )}\n`;
}

export function renderGoldenFixture(profile: DatasetProfile): string {
  return `${JSON.stringify(
    {
      name: `${profile.source}.summary (L0 fixed spec)`,
      input: { kind: "intent", intent: { canonical: `${profile.source}.summary`, params: {} } },
      drafts: [],
      expected: null,
    },
    null,
    2,
  )}\n`;
}

export function renderReadme(profile: DatasetProfile): string {
  const dims = profile.dimensions.map((d) => `\`${d.name}\``).join(", ");
  const measures = profile.measures.map((m) => `\`${m.name}\``).join(", ") || "(none — row counts only)";
  return `# ${profile.source} · kohaku quickstart

Generated by \`kohaku init\` from your data (${profile.rowCount} rows). Dimensions: ${dims}. Measures: ${measures}. Time: ${profile.time != null ? `\`${profile.time.name}\`` : "(none)"}.

## Run

\`\`\`bash
npm run dev                          # API on :8787 and the web app on :5173
KOHAKU_GOLDEN_UPDATE=1 npm test      # once: writes test/golden/summary.json's expected; then plain \`npm test\` asserts it
\`\`\`

Open http://localhost:5173. The **Summary** view is an L0 fixed Spec and renders without an LLM. **Chat** and the other views
(Trend / Records) are composed by the LLM: edit \`.env\` (created for you with a capability secret) and set a provider key
(or point it at a local ollama); \`.env.example\` documents every variable.
Chat answers only within the generated Intent catalog; a question outside it returns \`NO_MATCH\`. To widen it, see
Next steps (\`fallbackIntent\`).

## What was generated

- \`data/${profile.source}.json\` — your rows, normalized (column names as snake_case). Replace it to refresh the data.
- \`server/intents.ts\` — the Intent catalog (\`defineVocabulary\` / \`defineIntent\`). Vocabularies are the categorical columns.
- \`server/domain-port.ts\` — the DomainPort (sum / avg / count × group by × time window). Your data never enters the model: only column metadata does.
- \`server/fixed-specs.ts\` — the L0 fixed Spec for \`${profile.source}.summary\`.
- \`server/app.ts\` — the wiring (host-rest + in-memory storage + HMAC capabilities + the LLM SemanticPort). Every default here is a starting point; the contract is \`@kohaku-ui/spec-core\`'s \`ports.ts\`.
- \`web/main.tsx\` — Dashboard + Chat on renderer-react.
- \`test/golden.test.ts\` — golden regression. Generate the fixture's \`expected\` once with \`KOHAKU_GOLDEN_UPDATE=1 npm test\` (review, commit); \`npm test\` then asserts it.

## Next steps

- L2 free generation, promotion and fixation (adoption-ladder Step 2): set \`allowL2: true\` in \`server/app.ts\`, add a catch-all Intent and pass it as \`fallbackIntent\`, and wire \`@kohaku-ui/lineage\` — see https://github.com/yosuque/kohaku/blob/main/docs/user-guide.md#6-embedding-it-into-your-own-product
- Production storage / auth: \`@kohaku-ui/storage-redis\`, \`@kohaku-ui/storage-postgres\`, \`@kohaku-ui/authz-jwt\`.
`;
}

/**
 * The generated `.env` (git-ignored by GITIGNORE_TEMPLATE): a real, working `KOHAKU_CAPABILITY_SECRET` so
 * the project runs out of the box, unlike `.env.example`'s empty placeholder. `initProject` is the only
 * caller (see its `secret` option) — kept separate from `renderProjectFiles` so that function stays a pure,
 * deterministic function of `profile` / `rows` / `options`, with no randomness for its own tests to inject around.
 *
 * Also carries a commented copy of `.env.example`'s provider-key block, so `.env` is self-sufficient: the
 * onboarding instruction is "edit .env", not "copy .env.example to .env" (which would overwrite the secret
 * just written above with an empty value and make the generated server throw).
 */
export function renderEnvFile(secret: string): string {
  return `# Generated by \`kohaku init\`. Not committed (see .gitignore) -- this is a real secret, unlike .env.example.
KOHAKU_CAPABILITY_SECRET=${secret}

# Pick one provider to enable chat and the other LLM-composed views (the Summary dashboard works without one).
# KOHAKU_LLM_PROVIDER=claude
# KOHAKU_LLM_API_KEY=   # or export ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY instead
# Local, no key: KOHAKU_LLM_PROVIDER=ollama KOHAKU_LLM_MODEL=gemma4:e4b
`;
}

export function renderProjectFiles(
  profile: DatasetProfile,
  rows: Row[],
  options: { name: string },
): ProjectFile[] {
  return [
    { path: "package.json", content: renderPackageJson(options.name, profile) },
    { path: "tsconfig.json", content: TSCONFIG_TEMPLATE },
    { path: "vite.config.ts", content: VITE_CONFIG_TEMPLATE },
    { path: "index.html", content: INDEX_HTML_TEMPLATE.replaceAll("__NAME__", options.name) },
    { path: "dev.mjs", content: DEV_SCRIPT_TEMPLATE },
    { path: ".env.example", content: ENV_EXAMPLE_TEMPLATE },
    { path: ".gitignore", content: GITIGNORE_TEMPLATE },
    { path: "README.md", content: renderReadme(profile) },
    { path: `data/${profile.source}.json`, content: `${JSON.stringify(rows)}\n` },
    { path: "server/dataset.ts", content: renderDataset(profile) },
    { path: "server/domain-port.ts", content: DOMAIN_PORT_TEMPLATE },
    { path: "server/intents.ts", content: renderIntents(profile) },
    { path: "server/fixed-specs.ts", content: renderFixedSpecs(profile) },
    { path: "server/app.ts", content: APP_TEMPLATE },
    { path: "server/main.ts", content: MAIN_TEMPLATE },
    { path: "web/main.tsx", content: WEB_MAIN_TEMPLATE },
    { path: "test/golden.test.ts", content: GOLDEN_TEST_TEMPLATE_INIT },
    { path: "test/golden/summary.json", content: renderGoldenFixture(profile) },
  ];
}
