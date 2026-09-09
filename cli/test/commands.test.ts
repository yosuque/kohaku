import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  type ExportDatasetResult,
  exportDataset,
  parseIntentArg,
  parseSmokeL2Input,
  runRestConformance,
  runSelfConformance,
  runSmokeL2,
  scaffoldGolden,
  scaffoldPorts,
  validateComponentFile,
} from "../src/commands.js";

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "kohaku-cli-"));
  tmpDirs.push(dir);
  return dir;
}

describe("validateComponentFile", () => {
  it("a valid ComponentDefinition has no issues", () => {
    const path = join(tmp(), "ok.json");
    writeFileSync(
      path,
      JSON.stringify({
        type: "sales.calendarHeatmap",
        version: "1.0.0",
        description: "Display sales as a monthly calendar heatmap",
        propsSchema: { type: "object" },
        capabilities: { data: "required" },
      }),
    );
    expect(validateComponentFile(path)).toEqual([]);
  });

  it("detects all missing/invalid fields", () => {
    const path = join(tmp(), "bad.json");
    writeFileSync(
      path,
      JSON.stringify({
        type: "Invalid Type!",
        version: "not-semver",
        description: "  ",
        propsSchema: { type: "array" },
        capabilities: { data: "sometimes" },
      }),
    );
    const fields = validateComponentFile(path).map((i) => i.field);
    expect(fields).toContain("type");
    expect(fields).toContain("version");
    expect(fields).toContain("description");
    expect(fields).toContain("propsSchema");
    expect(fields).toContain("capabilities.data");
  });

  it("a file that cannot be read as JSON returns a (file) issue", () => {
    const path = join(tmp(), "broken.json");
    writeFileSync(path, "{ not valid json");
    const issues = validateComponentFile(path);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.field).toBe("(file)");
  });
});

describe("scaffoldPorts", () => {
  it("generates ports.ts / server.ts in an empty directory", () => {
    const written = scaffoldPorts(tmp());
    expect(written).toHaveLength(2);
    expect(written.some((p) => p.endsWith("ports.ts"))).toBe(true);
    expect(written.some((p) => p.endsWith("server.ts"))).toBe(true);
  });

  it("throws without overwriting when a file already exists", () => {
    const dir = tmp();
    writeFileSync(join(dir, "ports.ts"), "// existing");
    expect(() => scaffoldPorts(dir)).toThrow(/already exists/);
  });

  it("throws without partially generating ports.ts even when only server.ts exists (atomicity)", () => {
    // Without check-all-then-write, after writing ports.ts a server.ts collision would throw and
    // leave ports.ts behind. This guarantees that every file is checked before writing.
    const dir = tmp();
    writeFileSync(join(dir, "server.ts"), "// existing");
    expect(() => scaffoldPorts(dir)).toThrow(/already exists/);
    expect(existsSync(join(dir, "ports.ts"))).toBe(false);
  });
});

describe("scaffoldGolden", () => {
  it("generates golden.test.ts and golden/README.md", () => {
    const dir = tmp();
    const written = scaffoldGolden(dir);
    expect(written).toHaveLength(2);
    expect(existsSync(join(dir, "golden.test.ts"))).toBe(true);
    expect(existsSync(join(dir, "golden", "README.md"))).toBe(true);
  });

  it("the generated golden.test.ts contains runGolden wiring and update instructions", () => {
    const dir = tmp();
    scaffoldGolden(dir);
    const test = readFileSync(join(dir, "golden.test.ts"), "utf8");
    // The heart of the regression (runGolden) and the deterministic response source (FakeLlm) are wired up
    expect(test).toContain("runGolden");
    expect(test).toContain("@kohaku-ui/evals");
    expect(test).toContain("FakeLlm");
    // The update procedure (regenerating golden on an intentional change) is written in the comments
    expect(test).toContain("KOHAKU_GOLDEN_UPDATE=1");
    // The wiring point the user fills in remains as a TODO
    expect(test).toContain("makeContext");
  });

  it("throws without overwriting when a file already exists", () => {
    const dir = tmp();
    writeFileSync(join(dir, "golden.test.ts"), "// existing");
    expect(() => scaffoldGolden(dir)).toThrow(/already exists/);
  });

  it("throws without partially generating golden/README.md even when only golden.test.ts exists (atomicity)", () => {
    // Without check-all-then-write, after writing README a golden.test.ts collision would throw and
    // leave README behind. This guarantees that every file is checked before writing.
    const dir = tmp();
    writeFileSync(join(dir, "golden.test.ts"), "// existing");
    expect(() => scaffoldGolden(dir)).toThrow(/already exists/);
    expect(existsSync(join(dir, "golden", "README.md"))).toBe(false);
  });
});

describe("parseIntentArg", () => {
  it("decomposes valid JSON into canonical/params", () => {
    expect(parseIntentArg('{"canonical":"sales.trend","params":{"metric":"revenue"}}')).toEqual({
      canonical: "sales.trend",
      params: { metric: "revenue" },
    });
  });

  it("invalid JSON errors showing --intent usage", () => {
    expect(() => parseIntentArg("{ broken")).toThrow(/--intent/);
  });

  it("missing canonical is a shape error", () => {
    expect(() => parseIntentArg('{"params":{}}')).toThrow(/canonical/);
  });

  it("non-object params is a shape error", () => {
    expect(() => parseIntentArg('{"canonical":"x","params":"nope"}')).toThrow(/--intent/);
  });

  it("array params is a shape error (prevents the typeof [] === object miss)", () => {
    // Letting an array through as a Record would turn into numeric keys in rest-host's spread, so reject it
    expect(() => parseIntentArg('{"canonical":"x","params":[]}')).toThrow(/--intent/);
    expect(() => parseIntentArg('{"canonical":"x","params":[1,2,3]}')).toThrow(/--intent/);
  });
});

describe("runRestConformance (--intent validation)", () => {
  it("an invalid intent is rejected before reaching the network", async () => {
    // baseUrl is a dummy: parseIntentArg throws first, so fetch is never called
    await expect(runRestConformance("http://localhost:0", "{ broken")).rejects.toThrow(/--intent/);
  });
});

describe("runRestConformance (host reachability)", () => {
  it("an unreachable host fails fast with one clear message instead of the full suite's per-check fetch errors", async () => {
    // Port 0 is never a listening server, so fetch() rejects at the connection level (ECONNREFUSED-equivalent).
    const baseUrl = "http://localhost:0/api/kohaku";
    await expect(runRestConformance(baseUrl)).rejects.toThrow(/Cannot reach .*Is the host running/s);
  });
});

describe("runSelfConformance", () => {
  it("the Spec format self-check is CONFORMANT within its scope", async () => {
    const report = await runSelfConformance();
    expect(report.pass).toBe(true);
    // --self covers only the spec target. The MUSTs of MCP / sandbox / lineage remain unchecked
    // (this list being non-empty is what keeps CONFORMANT from being misread as passing all MUSTs).
    expect(report.notCheckedMustIds.length).toBeGreaterThan(0);
  });
});

// A sidecar contract that lets an implementation without a JS runtime (Python, etc.) reuse the TS validation logic in a Node co-located environment.
// lint = <script> syntax check (collectScriptSyntaxIssues) / smoke = ready-reached check under jsdom execution.
const _READY_HTML = "<!DOCTYPE html><html><body><script>window.kohaku.ready();</script></body></html>";
// An unterminated string literal (raw newline) = a JS syntax error. Does not touch lexical lint (hallucinated APIs, missing ready).
const _SYNTAX_ERROR_HTML = [
  "<!DOCTYPE html><html><body><script>",
  "let s = '<div>",
  "';",
  "window.kohaku.ready();",
  "</script></body></html>",
].join("\n");

describe("parseSmokeL2Input", () => {
  it("decomposes lint input into html/mode", () => {
    expect(parseSmokeL2Input('{"html":"<html></html>","mode":"lint"}')).toEqual({
      html: "<html></html>",
      mode: "lint",
    });
  });

  it("smoke input also takes in shape / readyTimeoutMs", () => {
    const shape = { columns: [{ name: "amount", type: "number", role: "measure" }] };
    const input = parseSmokeL2Input(
      JSON.stringify({ html: "<html></html>", mode: "smoke", shape, readyTimeoutMs: 200 }),
    );
    expect(input.mode).toBe("smoke");
    expect(input.readyTimeoutMs).toBe(200);
    expect(input.shape).toEqual(shape);
  });

  it("invalid JSON is a one-line error", () => {
    expect(() => parseSmokeL2Input("{ broken")).toThrow(/Cannot parse/);
  });

  it("missing/non-string html is a shape error", () => {
    expect(() => parseSmokeL2Input('{"mode":"lint"}')).toThrow(/html/);
    expect(() => parseSmokeL2Input('{"html":123,"mode":"lint"}')).toThrow(/html/);
  });

  it("a mode other than lint/smoke is a shape error", () => {
    expect(() => parseSmokeL2Input('{"html":"<html></html>","mode":"nope"}')).toThrow(/mode/);
    expect(() => parseSmokeL2Input('{"html":"<html></html>"}')).toThrow(/mode/);
  });

  it("non-numeric readyTimeoutMs or non-object shape is a shape error", () => {
    expect(() => parseSmokeL2Input('{"html":"<html></html>","mode":"smoke","readyTimeoutMs":"x"}')).toThrow(
      /readyTimeoutMs/,
    );
    expect(() => parseSmokeL2Input('{"html":"<html></html>","mode":"smoke","shape":[]}')).toThrow(/shape/);
  });
});

describe("runSmokeL2 (lint = <script> syntax check)", () => {
  it("detects a syntax error as L2_SCRIPT_SYNTAX", async () => {
    const { issues } = await runSmokeL2({ html: _SYNTAX_ERROR_HTML, mode: "lint" });
    expect(issues.some((i) => i.startsWith("L2_SCRIPT_SYNTAX"))).toBe(true);
  });

  it("syntactically valid HTML has no findings ([])", async () => {
    expect(await runSmokeL2({ html: _READY_HTML, mode: "lint" })).toEqual({ issues: [] });
  });

  it("lint does not react to lexical lint (e.g. hallucinated APIs) (syntax check only)", async () => {
    // window.kohaku.onReady is a non-existent API, but it is syntactically valid so lint mode does not catch it
    // (lexical lint is the Python side's own; from TS we borrow only the syntax-check part that requires JS execution).
    const hallucinated =
      "<!DOCTYPE html><html><body><script>window.kohaku.onReady(function () {});</script></body></html>";
    expect(await runSmokeL2({ html: hallucinated, mode: "lint" })).toEqual({ issues: [] });
  });
});

describe("runSmokeL2 (smoke = ready-reached check via jsdom execution)", () => {
  it("HTML that calls ready() has no findings ([])", async () => {
    expect(await runSmokeL2({ html: _READY_HTML, mode: "smoke", readyTimeoutMs: 300 })).toEqual({
      issues: [],
    });
  });

  it("HTML that does not call ready() yields L2_SMOKE_NO_READY", async () => {
    const noReady = "<!DOCTYPE html><html><body><script>void 0;</script></body></html>";
    const { issues } = await runSmokeL2({ html: noReady, mode: "smoke", readyTimeoutMs: 300 });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^L2_SMOKE_NO_READY/);
  });
});

const HASH_A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function fixationRecordJson(intentHash: string, ref: string, fixatedAt: string): unknown {
  return {
    intentHash,
    canonical: "sales.trend",
    structureHash: "sha256:structure",
    fixatedAt,
    approver: { id: "user-1" },
    pinnedSpec: {
      kohaku: "0.2",
      intent: { canonical: "sales.trend", params: {}, hash: intentHash },
      dataVersion: "ledger@1",
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["chart"] },
        { id: "chart", type: "presentChart", props: { kind: "line" }, data: { $ref: ref } },
      ],
      events: [],
      provenance: { tier: "L1", composedBy: "composer@0.1.0", cache: "hit" },
    },
  };
}

function goldenSpecJson(intentHash: string, ref: string): unknown {
  return {
    kohaku: "0.2",
    intent: { canonical: "sales.custom", params: {}, hash: intentHash },
    dataVersion: "ledger@1",
    components: [{ id: "root", type: "presentChart", props: {}, data: { $ref: ref } }],
    events: [],
    provenance: { tier: "L1", composedBy: "composer@0.1.0", cache: "hit" },
  };
}

describe("exportDataset (CLI: dataset export)", () => {
  it("reads a fixations.json snapshot ({key -> FixationRecord}) and writes a JSONL dataset", () => {
    const dir = tmp();
    const fixationsPath = join(dir, "fixations.json");
    writeFileSync(
      fixationsPath,
      JSON.stringify({
        [HASH_B]: fixationRecordJson(HASH_B, "query://ledger/b", "2026-01-02T00:00:00Z"),
        [HASH_A]: fixationRecordJson(HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z"),
      }),
    );
    const outPath = join(dir, "out.jsonl");

    const result = exportDataset({ fixationsPath, outPath });
    expect(result).toEqual({ fixations: 2, golden: 0, outPath, skipped: 0 });

    const lines = readFileSync(outPath, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    const records = lines.map((l) => JSON.parse(l) as { meta: { fixatedAt: string } });
    // sorted by intentHash ascending
    expect(records[0]!.meta.fixatedAt).toBe("2026-01-01T00:00:00Z");
    expect(records[1]!.meta.fixatedAt).toBe("2026-01-02T00:00:00Z");
  });

  it("includes golden Specs from --golden <dir> (both {expected} fixture files and plain UISpec files)", () => {
    const dir = tmp();
    const fixationsPath = join(dir, "fixations.json");
    writeFileSync(fixationsPath, JSON.stringify({}));

    const goldenDir = join(dir, "golden");
    mkdirSync(goldenDir);
    writeFileSync(
      join(goldenDir, "case1.json"),
      JSON.stringify({
        name: "case1",
        input: {},
        drafts: [],
        expected: goldenSpecJson(HASH_A, "query://ledger/a"),
      }),
    );
    // A fixture whose expected has not been generated yet (expected: null) is silently skipped.
    writeFileSync(
      join(goldenDir, "pending.json"),
      JSON.stringify({ name: "pending", input: {}, drafts: [], expected: null }),
    );
    // A plain UISpec file (no {name, input, drafts, expected} wrapper) is also accepted.
    writeFileSync(join(goldenDir, "plain.json"), JSON.stringify(goldenSpecJson(HASH_B, "query://ledger/b")));
    writeFileSync(join(goldenDir, "README.md"), "not json, must be ignored");

    const outPath = join(dir, "out.jsonl");
    const result = exportDataset({ fixationsPath, goldenDir, outPath });
    expect(result).toEqual({ fixations: 0, golden: 2, outPath, skipped: 0 });

    const lines = readFileSync(outPath, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => (JSON.parse(l) as { source: string }).source === "golden")).toBe(true);
  });

  it("skips an invalid FixationRecord entry (fail-open), reporting it on stderr and in the result", () => {
    const dir = tmp();
    const fixationsPath = join(dir, "fixations.json");
    writeFileSync(
      fixationsPath,
      JSON.stringify({
        [HASH_A]: fixationRecordJson(HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z"),
        bad: { not: "a fixation record" },
      }),
    );
    const outPath = join(dir, "out.jsonl");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let result: ExportDatasetResult;
    let stderrCalls: unknown[][];
    try {
      result = exportDataset({ fixationsPath, outPath });
      stderrCalls = stderrSpy.mock.calls;
    } finally {
      stderrSpy.mockRestore();
    }
    expect(result).toEqual({ fixations: 1, golden: 0, outPath, skipped: 1 });
    expect(stderrCalls).toEqual([[expect.stringMatching(/skipped "bad".*not a valid FixationRecord/)]]);

    const lines = readFileSync(outPath, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(1);
  });

  it("throws when fixations.json is not a {key -> record} object", () => {
    const dir = tmp();
    const fixationsPath = join(dir, "fixations.json");
    writeFileSync(fixationsPath, JSON.stringify([]));
    expect(() => exportDataset({ fixationsPath, outPath: join(dir, "out.jsonl") })).toThrow(
      /must be a JSON object/,
    );
  });

  it("throws a friendly error when --fixations does not exist", () => {
    const dir = tmp();
    const fixationsPath = join(dir, "does-not-exist.json");
    expect(() => exportDataset({ fixationsPath, outPath: join(dir, "out.jsonl") })).toThrow(
      /does not exist.*Approve a fixation first/s,
    );
  });

  it("throws when the --fixations file is not valid JSON", () => {
    const dir = tmp();
    const fixationsPath = join(dir, "fixations.json");
    writeFileSync(fixationsPath, "not json");
    expect(() => exportDataset({ fixationsPath, outPath: join(dir, "out.jsonl") })).toThrow();
  });

  it("throws when a --golden file does not contain a valid UISpec", () => {
    const dir = tmp();
    const fixationsPath = join(dir, "fixations.json");
    writeFileSync(fixationsPath, JSON.stringify({}));
    const goldenDir = join(dir, "golden");
    mkdirSync(goldenDir);
    writeFileSync(join(goldenDir, "bad.json"), JSON.stringify({ not: "a uispec" }));
    expect(() => exportDataset({ fixationsPath, goldenDir, outPath: join(dir, "out.jsonl") })).toThrow(
      /does not contain a valid UISpec/,
    );
  });

  it("creates the output file's parent directory if it does not exist yet", () => {
    const dir = tmp();
    const fixationsPath = join(dir, "fixations.json");
    writeFileSync(fixationsPath, JSON.stringify({}));
    const outPath = join(dir, "nested", "deeper", "out.jsonl");
    const result = exportDataset({ fixationsPath, outPath });
    expect(result).toEqual({ fixations: 0, golden: 0, outPath, skipped: 0 });
    expect(existsSync(outPath)).toBe(true);
  });

  it("restricts the export to fixations owned by --tenant", () => {
    const dir = tmp();
    const fixationsPath = join(dir, "fixations.json");
    const recA = fixationRecordJson(HASH_A, "query://ledger/a", "2026-01-01T00:00:00Z") as Record<
      string,
      unknown
    >;
    const recB = fixationRecordJson(HASH_B, "query://ledger/b", "2026-01-02T00:00:00Z") as Record<
      string,
      unknown
    >;
    writeFileSync(
      fixationsPath,
      JSON.stringify({
        "tenant-a key-a": { ...recA, tenant: "tenant-a" },
        "tenant-b key-b": { ...recB, tenant: "tenant-b" },
      }),
    );
    const outPath = join(dir, "out.jsonl");
    const result = exportDataset({ fixationsPath, outPath, tenant: "tenant-a" });
    expect(result).toEqual({ fixations: 1, golden: 0, outPath, skipped: 0 });

    const lines = readFileSync(outPath, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as { meta: { tenant: string } }).meta.tenant).toBe("tenant-a");
  });
});
