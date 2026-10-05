/**
 * kohaku usage export: the CSV format (fixed header, RFC 4180 quoting), --data-dir (a FileStoragePort written
 * into a mkdtemp directory, exhaustive paging over more than one page), --rest (Hono's app.request as the
 * client transport, scoped by the x-kohaku-tenant header), and usage errors (exit 2 via CliUsageError).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComposeContext } from "@kohaku-ui/composer";
import { createKohakuRoutes, type KohakuHostDeps } from "@kohaku-ui/host-rest";
import type { UsageRow } from "@kohaku-ui/lineage";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type {
  AuthzPort,
  DomainPort,
  LineageEventRecord,
  SemanticPort,
  StoragePort,
} from "@kohaku-ui/spec-core";
import { createFileStoragePort, createMemoryStoragePort } from "@kohaku-ui/storage-memory";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { EvidenceUsageError } from "../src/evidence/window.js";
import { CliUsageError } from "../src/lineage-window.js";
import { formatUsageCsv, USAGE_CSV_HEADER } from "../src/usage/csv.js";
import { runUsageExport } from "../src/usage/export.js";
import { streamLineageChunks } from "../src/usage/lineage-file.js";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "../bin/kohaku.js");

const EXPECTED_HEADER =
  "day,tenant,composed,cache_hit,cache_miss,cache_bypass,cache_fixated,l0,l1,l2,l2_generated,fallbacks,tokens_in,tokens_out,fixations_created,fixations_removed";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function row(partial: Partial<UsageRow> = {}): UsageRow {
  return {
    day: "2026-07-01",
    tenant: "",
    composed: 0,
    cache: { hit: 0, miss: 0, bypass: 0, fixated: 0 },
    tiers: { L0: 0, L1: 0, L2: 0 },
    l2Generated: 0,
    fallbacks: 0,
    tokens: { input: 0, output: 0 },
    fixationsCreated: 0,
    fixationsRemoved: 0,
    ...partial,
  };
}

let seq = 0;
function composed(args: {
  ts: string;
  tenant?: string;
  tier?: "L0" | "L1" | "L2";
  cache?: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** `payload.fallback`: a fallback Spec was served (it keeps the failed tier / cache label). */
  fallback?: { from: string; reason: string };
}): LineageEventRecord {
  return {
    id: `usage-ev-${seq++}`,
    ts: args.ts,
    actor: { kind: "model" },
    type: "view.composed",
    payload: {
      tier: args.tier ?? "L1",
      cache: args.cache ?? "miss",
      intentHash: "sha256:aaa",
      canonical: "sales.trend",
      ...(args.usage != null ? { decision: { attempts: [], usage: args.usage } } : {}),
      ...(args.fallback != null ? { fallback: args.fallback } : {}),
    },
    ...(args.tenant != null ? { tenant: args.tenant } : {}),
  };
}

function other(type: string, ts: string, tenant?: string): LineageEventRecord {
  return {
    id: `usage-ev-${seq++}`,
    ts,
    actor: { kind: "system" },
    type,
    payload: {},
    ...(tenant != null ? { tenant } : {}),
  };
}

async function seed(storage: StoragePort, events: LineageEventRecord[]): Promise<void> {
  for (const e of events) await storage.appendLineage(e);
}

const EVENTS: LineageEventRecord[] = [
  composed({
    ts: "2026-07-01T10:00:00.000Z",
    tenant: "acme",
    tier: "L2",
    usage: { inputTokens: 100, outputTokens: 10 },
  }),
  composed({ ts: "2026-07-01T11:00:00.000Z", tenant: "acme", tier: "L1", cache: "hit" }),
  // The fallback Spec is counted off its view.composed record (it keeps tier L2, so it is not a generation) ...
  composed({
    ts: "2026-07-01T12:00:00.000Z",
    tenant: "acme",
    tier: "L2",
    fallback: { from: "L2", reason: "generation failed" },
  }),
  // ... and the REST host's extra view.fallback record is neither read nor double-counted.
  other("view.fallback", "2026-07-01T12:00:00.000Z", "acme"),
  other("intent.fixated", "2026-07-02T09:00:00.000Z", "acme"),
  composed({
    ts: "2026-07-02T10:00:00.000Z",
    tenant: "globex",
    tier: "L2",
    cache: "bypass",
    usage: { inputTokens: 7, outputTokens: 3 },
  }),
  composed({ ts: "2026-07-02T11:00:00.000Z" }),
  other("component.generated", "2026-07-02T12:00:00.000Z", "acme"), // not a metering event
  composed({ ts: "2026-08-15T00:00:00.000Z", tenant: "acme" }), // outside the window
];

describe("formatUsageCsv", () => {
  it("emits the fixed header, and the header alone for no rows", () => {
    expect(USAGE_CSV_HEADER.join(",")).toBe(EXPECTED_HEADER);
    expect(formatUsageCsv([])).toBe(`${EXPECTED_HEADER}\n`);
  });

  it("maps one row to its columns in header order", () => {
    const csv = formatUsageCsv([
      row({
        day: "2026-07-01",
        tenant: "acme",
        composed: 9,
        cache: { hit: 1, miss: 2, bypass: 3, fixated: 4 },
        tiers: { L0: 5, L1: 6, L2: 7 },
        l2Generated: 8,
        fallbacks: 10,
        tokens: { input: 11, output: 12 },
        fixationsCreated: 13,
        fixationsRemoved: 14,
      }),
    ]);
    expect(csv.split("\n")[1]).toBe("2026-07-01,acme,9,1,2,3,4,5,6,7,8,10,11,12,13,14");
  });

  it("prefixes a tenant that starts with a formula character with an apostrophe (CSV injection)", () => {
    const csv = formatUsageCsv([
      row({ tenant: "=HYPERLINK(1)" }),
      row({ tenant: "+1" }),
      row({ tenant: "-1" }),
      row({ tenant: "@SUM" }),
      row({ tenant: "\tx" }),
      row({ tenant: "a=b" }), // not at the start: untouched
      row({ tenant: "=a,b" }), // the guard and the RFC 4180 quoting compose
    ]);
    const tenants = csv
      .split("\n")
      .slice(1, 8)
      .map((line) => line.split(",")[1]);
    expect(tenants).toEqual(["'=HYPERLINK(1)", "'+1", "'-1", "'@SUM", "'\tx", "a=b", "\"'=a"]);
    expect(csv).toContain('2026-07-01,"\'=a,b",0');
  });

  it("quotes a tenant containing a comma, a double quote or a newline (RFC 4180)", () => {
    const csv = formatUsageCsv([
      row({ tenant: "a,b" }),
      row({ tenant: 'say "hi"' }),
      row({ tenant: "line1\nline2" }),
    ]);
    expect(csv).toContain('2026-07-01,"a,b",0');
    expect(csv).toContain('2026-07-01,"say ""hi""",0');
    expect(csv).toContain('2026-07-01,"line1\nline2",0');
  });
});

describe("kohaku usage export --data-dir", () => {
  const window = { since: "2026-07-01", until: "2026-07-31" };

  it("derives per-day per-tenant rows from the file-backed lineage (a date-only --until includes that whole day)", async () => {
    const dataDir = tmp("kohaku-usage-data-");
    await seed(createFileStoragePort(dataDir), EVENTS);

    const { rows, text } = await runUsageExport({ dataDir, ...window, format: "json" });
    expect(JSON.parse(text)).toEqual(rows);
    expect(rows.map((r) => `${r.day}/${r.tenant}`)).toEqual([
      "2026-07-01/acme",
      "2026-07-02/",
      "2026-07-02/acme",
      "2026-07-02/globex",
    ]);
    const acme1 = rows[0]!;
    expect(acme1).toMatchObject({
      composed: 3,
      l2Generated: 1,
      fallbacks: 1,
      tokens: { input: 100, output: 10 },
      cache: { hit: 1, miss: 2, bypass: 0, fixated: 0 },
    });
    expect(rows[2]).toMatchObject({ composed: 0, fixationsCreated: 1 });
    expect(rows[3]).toMatchObject({ composed: 1, l2Generated: 1, tokens: { input: 7, output: 3 } });
  });

  it("restricts to --tenant and writes the CSV to --out", async () => {
    const dataDir = tmp("kohaku-usage-data-");
    await seed(createFileStoragePort(dataDir), EVENTS);
    const out = join(tmp("kohaku-usage-out-"), "nested", "usage.csv");

    const result = await runUsageExport({ dataDir, tenant: "acme", ...window, out });
    expect(result.outPath).toBe(out);
    const written = readFileSync(out, "utf8");
    expect(written).toBe(result.text);
    const lines = written.trimEnd().split("\n");
    expect(lines[0]).toBe(EXPECTED_HEADER);
    expect(lines.slice(1).map((l) => l.split(",").slice(0, 2).join(","))).toEqual([
      "2026-07-01,acme",
      "2026-07-02,acme",
    ]);
  });

  it("pages through the whole log, not just one page (more events than the page size)", async () => {
    const dataDir = tmp("kohaku-usage-data-");
    const many: LineageEventRecord[] = [];
    for (let i = 0; i < 1200; i++) many.push(composed({ ts: "2026-07-03T00:00:00.000Z", tenant: "acme" }));
    await seed(createFileStoragePort(dataDir), many);

    const { rows } = await runUsageExport({ dataDir, ...window });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.composed).toBe(1200);
  });

  it("refuses a page cursor that does not advance instead of paging forever", async () => {
    const dataDir = tmp("kohaku-usage-data-");
    const stuck: StoragePort = {
      ...createMemoryStoragePort(),
      async pageLineage() {
        return { events: [composed({ ts: "2026-07-03T00:00:00.000Z" })], nextCursor: "same" };
      },
    };
    await expect(runUsageExport({ dataDir, storage: stuck, ...window })).rejects.toThrow(/same nextCursor/);
  });

  it("folds pages as they arrive: the rows equal one pass over every event", async () => {
    const dataDir = tmp("kohaku-usage-data-");
    const many: LineageEventRecord[] = [];
    for (let i = 0; i < 1500; i++) {
      many.push(
        composed({
          ts: `2026-07-0${(i % 2) + 1}T00:00:00.000Z`,
          tenant: i % 3 === 0 ? "acme" : "globex",
          tier: "L2",
          usage: { inputTokens: 2, outputTokens: 1 },
        }),
      );
    }
    await seed(createFileStoragePort(dataDir), many);
    const { rows } = await runUsageExport({ dataDir, ...window });
    expect(rows.map((r) => `${r.day}/${r.tenant}`)).toEqual([
      "2026-07-01/acme",
      "2026-07-01/globex",
      "2026-07-02/acme",
      "2026-07-02/globex",
    ]);
    expect(rows.reduce((n, r) => n + r.composed, 0)).toBe(1500);
    expect(rows.reduce((n, r) => n + r.tokens.input, 0)).toBe(3000);
  });

  it("yields the header only for an empty window", async () => {
    const dataDir = tmp("kohaku-usage-data-");
    const { rows, text } = await runUsageExport({ dataDir, ...window });
    expect(rows).toEqual([]);
    expect(text).toBe(`${EXPECTED_HEADER}\n`);
  });

  it("the CLI prints the fixed-header CSV to stdout and exits 0", async () => {
    const dataDir = tmp("kohaku-usage-data-");
    await seed(createFileStoragePort(dataDir), EVENTS);
    const result = spawnSync(
      process.execPath,
      [
        bin,
        "usage",
        "export",
        "--data-dir",
        dataDir,
        "--since",
        "2026-07-01",
        "--until",
        "2026-07-31",
        "--format",
        "csv",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.split("\n")[0]).toBe(EXPECTED_HEADER);
    expect(result.stdout).toContain("2026-07-01,acme,3,");
  }, 30_000);
});

describe("kohaku usage export --data-dir reads lineage.jsonl as a read-only stream", () => {
  const window = { since: "2026-07-01", until: "2026-07-31" };

  /** Writes raw lines (valid or not) as a data directory's lineage.jsonl. */
  function writeLineage(dataDir: string, lines: string[]): void {
    writeFileSync(join(dataDir, "lineage.jsonl"), `${lines.join("\n")}\n`);
  }

  it("reads a hand-written lineage.jsonl, skipping and counting a malformed or invalid line and warning on stderr", async () => {
    const dataDir = tmp("kohaku-usage-stream-");
    writeLineage(dataDir, [
      JSON.stringify(composed({ ts: "2026-07-01T10:00:00.000Z", tenant: "acme", tier: "L2" })),
      "{not json", // a line cut off by a crash
      "",
      JSON.stringify({ id: "x", type: "view.composed" }), // JSON, but not a LineageEventRecord
      JSON.stringify(composed({ ts: "2026-07-01T11:00:00.000Z", tenant: "acme", tier: "L1" })),
      JSON.stringify(other("component.generated", "2026-07-01T12:00:00.000Z", "acme")), // not a metering event
      JSON.stringify(composed({ ts: "2026-08-15T00:00:00.000Z", tenant: "acme" })), // outside the window
    ]);
    const warnings: string[] = [];
    const result = await runUsageExport({ dataDir, ...window, warn: (m) => warnings.push(m) });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ day: "2026-07-01", tenant: "acme", composed: 2 });
    expect(result.skippedLines).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Skipped 2 malformed or invalid line(s)");
    expect(warnings[0]).toContain("lineage.jsonl");
  });

  it("does not warn when every line is valid", async () => {
    const dataDir = tmp("kohaku-usage-stream-");
    writeLineage(dataDir, [JSON.stringify(composed({ ts: "2026-07-01T10:00:00.000Z" }))]);
    const warnings: string[] = [];
    const result = await runUsageExport({ dataDir, ...window, warn: (m) => warnings.push(m) });
    expect(result.skippedLines).toBe(0);
    expect(warnings).toEqual([]);
  });

  it("leaves the data directory exactly as it found it, even with a corrupt promotions.json / fixations.json", async () => {
    const dataDir = tmp("kohaku-usage-stream-");
    writeLineage(dataDir, [JSON.stringify(composed({ ts: "2026-07-01T10:00:00.000Z", tenant: "acme" }))]);
    writeFileSync(join(dataDir, "promotions.json"), "{ this is not json");
    writeFileSync(join(dataDir, "fixations.json"), "[1, 2, 3]"); // parses, but is not a {key -> record} object
    const before = Object.fromEntries(
      readdirSync(dataDir).map((f) => [f, readFileSync(join(dataDir, f), "utf8")]),
    );

    const result = await runUsageExport({ dataDir, ...window });
    expect(result.rows).toHaveLength(1);

    // createFileStoragePort would have renamed both snapshots to *.corrupt; the export never opens them.
    const after = Object.fromEntries(
      readdirSync(dataDir).map((f) => [f, readFileSync(join(dataDir, f), "utf8")]),
    );
    expect(after).toEqual(before);
    expect(readdirSync(dataDir).some((f) => f.endsWith(".corrupt"))).toBe(false);
  });

  it("treats a data directory without a lineage.jsonl as an empty log and creates nothing in it", async () => {
    const dataDir = tmp("kohaku-usage-stream-");
    const result = await runUsageExport({ dataDir, ...window });
    expect(result.rows).toEqual([]);
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it("hands the rows over in chunks of at most 500 matching events, never the whole log at once", async () => {
    const dataDir = tmp("kohaku-usage-stream-");
    const lines: string[] = [];
    for (let i = 0; i < 1203; i++) lines.push(JSON.stringify(composed({ ts: "2026-07-03T00:00:00.000Z" })));
    for (let i = 0; i < 40; i++)
      lines.push(JSON.stringify(other("component.used", "2026-07-03T00:00:00.000Z")));
    writeLineage(dataDir, lines);
    const stats = { skippedLines: 0 };
    const sizes: number[] = [];
    for await (const chunk of streamLineageChunks(
      join(dataDir, "lineage.jsonl"),
      { type: ["view.composed"], since: "2026-07-01T00:00:00.000Z", until: "2026-07-31T23:59:59.999Z" },
      stats,
    )) {
      sizes.push(chunk.length);
    }
    expect(sizes).toEqual([500, 500, 203]);
    expect(stats.skippedLines).toBe(0);
  });

  it("applies the type, window and tenant filter the way a StoragePort does", async () => {
    const dataDir = tmp("kohaku-usage-stream-");
    writeLineage(dataDir, [
      JSON.stringify(composed({ ts: "2026-07-01T00:00:00.000Z", tenant: "acme" })),
      JSON.stringify(composed({ ts: "2026-07-01T00:00:00.000Z", tenant: "globex" })),
      JSON.stringify(composed({ ts: "2026-07-01T00:00:00.000Z" })), // no tenant
      JSON.stringify(composed({ ts: "2026-06-30T23:59:59.999Z", tenant: "acme" })), // before the window
      JSON.stringify(composed({ ts: "2026-07-31T23:59:59.999Z", tenant: "acme" })), // the last instant: included
    ]);
    const path = join(dataDir, "lineage.jsonl");
    const read = async (tenant?: string): Promise<number> => {
      let n = 0;
      for await (const chunk of streamLineageChunks(
        path,
        {
          type: ["view.composed"],
          since: "2026-07-01T00:00:00.000Z",
          until: "2026-07-31T23:59:59.999Z",
          ...(tenant != null ? { tenant } : {}),
        },
        { skippedLines: 0 },
      )) {
        n += chunk.length;
      }
      return n;
    };
    expect(await read()).toBe(4);
    expect(await read("acme")).toBe(2);
    expect(await read("globex")).toBe(1);
  });
});

describe("kohaku usage export usage errors", () => {
  it("rejects a bad window with EvidenceUsageError before touching storage", async () => {
    const dataDir = tmp("kohaku-usage-data-");
    await expect(runUsageExport({ dataDir, since: "yesterday", until: "2026-07-31" })).rejects.toBeInstanceOf(
      EvidenceUsageError,
    );
    await expect(
      runUsageExport({ dataDir, since: "2026-08-01", until: "2026-07-01" }),
    ).rejects.toBeInstanceOf(EvidenceUsageError);
    // The storage was never opened, so nothing was created in the data directory.
    expect(existsSync(join(dataDir, "lineage.jsonl"))).toBe(false);
  });

  it("rejects an empty --tenant (it would read as no filter) and says where tenant-less usage lands", async () => {
    const w = { since: "2026-07-01", until: "2026-07-31" };
    const dataDir = tmp("kohaku-usage-data-");
    await expect(runUsageExport({ dataDir, tenant: "", ...w })).rejects.toBeInstanceOf(CliUsageError);
    await expect(runUsageExport({ dataDir, tenant: "", ...w })).rejects.toThrow(
      /rows whose tenant column is empty/,
    );
    await expect(runUsageExport({ rest: "http://127.0.0.1:1", tenant: "", ...w })).rejects.toBeInstanceOf(
      CliUsageError,
    );
  });

  it("the CLI exits 2 for --tenant with an empty value", () => {
    const result = spawnSync(
      process.execPath,
      [
        bin,
        "usage",
        "export",
        "--data-dir",
        tmp("kohaku-usage-data-"),
        "--tenant",
        "",
        "--since",
        "2026-07-01",
        "--until",
        "2026-07-31",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--tenant must not be empty");
  }, 30_000);

  it("rejects an unknown --format with EvidenceUsageError", async () => {
    await expect(
      runUsageExport({
        dataDir: tmp("kohaku-usage-data-"),
        since: "2026-07-01",
        until: "2026-07-31",
        format: "xml" as unknown as "csv",
      }),
    ).rejects.toBeInstanceOf(EvidenceUsageError);
  });

  it("requires exactly one of --data-dir / --rest (usage errors)", async () => {
    const w = { since: "2026-07-01", until: "2026-07-31" };
    await expect(runUsageExport(w)).rejects.toThrow(/Specify either --data-dir/);
    await expect(runUsageExport(w)).rejects.toBeInstanceOf(CliUsageError);
    await expect(runUsageExport({ ...w, dataDir: "x", rest: "http://localhost:1" })).rejects.toThrow(
      /only one of --data-dir or --rest/,
    );
    await expect(runUsageExport({ ...w, dataDir: "x", rest: "http://localhost:1" })).rejects.toBeInstanceOf(
      CliUsageError,
    );
  });

  it("rejects a --data-dir that does not exist instead of creating it and exporting nothing", async () => {
    const missing = join(tmp("kohaku-usage-missing-"), "no-such-dir");
    const w = { since: "2026-07-01", until: "2026-07-31" };
    await expect(runUsageExport({ dataDir: missing, ...w })).rejects.toBeInstanceOf(CliUsageError);
    await expect(runUsageExport({ dataDir: missing, ...w })).rejects.toThrow(/not an existing directory/);
    expect(existsSync(missing)).toBe(false);
  });

  it("the CLI exits 2 for a --data-dir that does not exist", () => {
    const result = spawnSync(
      process.execPath,
      [
        bin,
        "usage",
        "export",
        "--data-dir",
        join(tmp("kohaku-usage-missing-"), "no-such-dir"),
        "--since",
        "2026-07-01",
        "--until",
        "2026-07-31",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not an existing directory");
  }, 30_000);

  it("the CLI exits 2 when --tenant disagrees with the x-kohaku-tenant header", () => {
    const result = spawnSync(
      process.execPath,
      [
        bin,
        "usage",
        "export",
        "--rest",
        "http://127.0.0.1:1/api/kohaku",
        "--header",
        "x-kohaku-tenant:acme",
        "--tenant",
        "globex",
        "--since",
        "2026-07-01",
        "--until",
        "2026-07-31",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("conflicts with the x-kohaku-tenant header");
  }, 30_000);

  it("the CLI exits 2 with a message for an invalid --since", () => {
    const result = spawnSync(
      process.execPath,
      [
        bin,
        "usage",
        "export",
        "--data-dir",
        tmp("kohaku-usage-data-"),
        "--since",
        "yesterday",
        "--until",
        "2026-07-31",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--since must be an ISO 8601 date");
  }, 30_000);

  it("the CLI help says the header decides the tenant and that no header reads every tenant", () => {
    const result = spawnSync(process.execPath, [bin, "usage", "export", "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    const help = result.stdout.replace(/\s+/g, " ");
    expect(help).toContain("--header decides the tenant");
    expect(help).toContain("without the header every tenant is read (legacy, unscoped hosts)");
  }, 30_000);
});

const catalog = resolveCatalog(coreCatalog);
const domain: DomainPort = {
  async listOperations() {
    return [];
  },
  async invoke() {
    return {};
  },
};
const stubSemantic: SemanticPort = {
  async normalize() {
    return { canonical: "sales.trend", params: {}, hash: "" };
  },
  async resolveQuery() {
    return { uri: "query://sales/summary" };
  },
  async dataVersion() {
    return "sales@v1";
  },
};
const allowAuthz: AuthzPort = {
  async issueCapability() {
    return "cap";
  },
  async verify() {
    return { ok: true, principal: { id: "u", roles: ["user"] } };
  },
};

function makeRestApp(storage: StoragePort): Hono {
  const compose: ComposeContext = {
    catalog,
    semantic: stubSemantic,
    storage,
    llm: new FakeLlm({ objects: [] }),
  };
  const deps: KohakuHostDeps = {
    compose,
    domain,
    authz: allowAuthz,
    querySource: "sales",
    tenant: (c) => c.req.header("x-kohaku-tenant") || undefined,
  };
  const app = new Hono();
  app.route("/api/kohaku", createKohakuRoutes(deps));
  return app;
}

describe("kohaku usage export --rest (in-process host-rest app)", () => {
  const window = { since: "2026-07-01", until: "2026-07-31" };

  it("pages GET /lineage and sees only the session's tenant (the x-kohaku-tenant header)", async () => {
    const storage = createMemoryStoragePort();
    await seed(storage, EVENTS);
    const app = makeRestApp(storage);
    const transport = (url: string, init?: RequestInit) => Promise.resolve(app.request(url, init));

    const acme = await runUsageExport({
      rest: "/api/kohaku",
      transport,
      headers: ["x-kohaku-tenant:acme"],
      ...window,
    });
    expect(acme.rows.map((r) => `${r.day}/${r.tenant}`)).toEqual(["2026-07-01/acme", "2026-07-02/acme"]);
    expect(acme.rows[0]).toMatchObject({
      composed: 3,
      l2Generated: 1,
      fallbacks: 1,
      tokens: { input: 100, output: 10 },
    });

    const globex = await runUsageExport({
      rest: "/api/kohaku",
      transport,
      headers: ["x-kohaku-tenant:globex"],
      ...window,
    });
    expect(globex.rows.map((r) => r.tenant)).toEqual(["globex"]);
    expect(globex.rows[0]).toMatchObject({ l2Generated: 1, tokens: { input: 7, output: 3 } });
  });

  it("rejects a --tenant that disagrees with the x-kohaku-tenant header", async () => {
    const storage = createMemoryStoragePort();
    const app = makeRestApp(storage);
    const transport = (url: string, init?: RequestInit) => Promise.resolve(app.request(url, init));
    await expect(
      runUsageExport({
        rest: "/api/kohaku",
        transport,
        headers: ["x-kohaku-tenant:acme"],
        tenant: "globex",
        ...window,
      }),
    ).rejects.toThrow(/conflicts with the x-kohaku-tenant header/);
    await expect(
      runUsageExport({
        rest: "/api/kohaku",
        transport,
        headers: ["x-kohaku-tenant:acme"],
        tenant: "globex",
        ...window,
      }),
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it("rejects a --tenant that has no x-kohaku-tenant header to back it (usage error)", async () => {
    await expect(
      runUsageExport({
        rest: "http://127.0.0.1:1/api/kohaku",
        tenant: "acme",
        since: "2026-07-01",
        until: "2026-07-31",
      }),
    ).rejects.toBeInstanceOf(CliUsageError);
  });
});
