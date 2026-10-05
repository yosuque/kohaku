/**
 * kohaku usage export: the CSV format (fixed header, RFC 4180 quoting), --data-dir (a FileStoragePort written
 * into a mkdtemp directory, exhaustive paging over more than one page), --rest (Hono's app.request as the
 * client transport, scoped by the x-kohaku-tenant header), and usage errors (exit 2 via EvidenceUsageError).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
import { formatUsageCsv, USAGE_CSV_HEADER } from "../src/usage/csv.js";
import { runUsageExport } from "../src/usage/export.js";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "../bin/kohaku.js");

const EXPECTED_HEADER =
  "day,tenant,composed,cache_hit,cache_miss,cache_bypass,cache_fixated,l0,l1,l2,l2_generated,fallbacks,tokens_in,tokens_out,fixated,unfixated";

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
    fixated: 0,
    unfixated: 0,
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
        fixated: 13,
        unfixated: 14,
      }),
    ]);
    expect(csv.split("\n")[1]).toBe("2026-07-01,acme,9,1,2,3,4,5,6,7,8,10,11,12,13,14");
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
      composed: 2,
      l2Generated: 1,
      fallbacks: 1,
      tokens: { input: 100, output: 10 },
      cache: { hit: 1, miss: 1, bypass: 0, fixated: 0 },
    });
    expect(rows[2]).toMatchObject({ composed: 0, fixated: 1 });
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
    expect(result.stdout).toContain("2026-07-01,acme,2,");
  }, 30_000);
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

  it("requires exactly one of --data-dir / --rest", async () => {
    const w = { since: "2026-07-01", until: "2026-07-31" };
    await expect(runUsageExport(w)).rejects.toThrow(/Specify either --data-dir/);
    await expect(runUsageExport({ ...w, dataDir: "x", rest: "http://localhost:1" })).rejects.toThrow(
      /only one of --data-dir or --rest/,
    );
  });

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

  it("the CLI help states that --rest sees only the session's tenant", () => {
    const result = spawnSync(process.execPath, [bin, "usage", "export", "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.replace(/\s+/g, " ")).toContain("Only the tenant of the session is visible");
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
      composed: 2,
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
  });
});
