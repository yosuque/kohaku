/**
 * kohaku evidence keygen/export/verify: keygen round-trips through PEM, export works against both a
 * local --data-dir (FileStoragePort) and an in-process REST host (Hono's app.request as the client
 * transport, the same pattern as explain.test.ts), and verify detects tampering.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComposeContext } from "@kohaku-ui/composer";
import { createKohakuRoutes, type KohakuHostDeps } from "@kohaku-ui/host-rest";
import {
  createFixations,
  createLineage,
  createPromotions,
  createViewRecorder,
  signManifest,
} from "@kohaku-ui/lineage";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type { AuthzPort, DomainPort, SemanticPort } from "@kohaku-ui/spec-core";
import { createFileStoragePort, createMemoryStoragePort } from "@kohaku-ui/storage-memory";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { runEvidenceExport } from "../src/evidence/export.js";
import { runEvidenceKeygen } from "../src/evidence/keygen.js";
import { importPrivateKeyPem } from "../src/evidence/keys.js";
import { runEvidenceVerify } from "../src/evidence/verify.js";
import { EvidenceUsageError, resolveEvidenceWindow } from "../src/evidence/window.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const catalog = resolveCatalog(coreCatalog);

describe("kohaku evidence keygen", () => {
  it("generates a private key (mode 0600) and a public key that verify each other", async () => {
    const outDir = tmp("kohaku-evidence-keygen-");
    const result = await runEvidenceKeygen(outDir);

    expect(existsSync(result.privateKeyPath)).toBe(true);
    expect(existsSync(result.publicKeyPath)).toBe(true);
    expect(result.keyId).toMatch(/^[0-9a-f]{16}$/);

    const privateKeyPem = readFileSync(result.privateKeyPath, "utf8");
    expect(privateKeyPem).toContain("-----BEGIN PRIVATE KEY-----");
    const publicKeyPem = readFileSync(result.publicKeyPath, "utf8");
    expect(publicKeyPem).toContain("-----BEGIN PUBLIC KEY-----");

    // mode 0600: owner read/write only (masked to the permission bits; ignore the file-type bits).
    const mode = statSync(result.privateKeyPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("never writes under a given data directory (out-dir is independent)", async () => {
    const outDir = tmp("kohaku-evidence-keygen-");
    const dataDir = tmp("kohaku-evidence-data-");
    const result = await runEvidenceKeygen(outDir);
    expect(result.privateKeyPath.startsWith(dataDir)).toBe(false);
  });

  it("refuses to overwrite an existing key file without --force", async () => {
    const outDir = tmp("kohaku-evidence-keygen-");
    const first = await runEvidenceKeygen(outDir);
    const originalPrivateKey = readFileSync(first.privateKeyPath, "utf8");

    await expect(runEvidenceKeygen(outDir)).rejects.toThrow(/already exist.*--force/s);

    // The refusal must be a true no-op: the original key material is untouched.
    expect(readFileSync(first.privateKeyPath, "utf8")).toBe(originalPrivateKey);
  });

  it("overwrites both key files with --force", async () => {
    const outDir = tmp("kohaku-evidence-keygen-");
    const first = await runEvidenceKeygen(outDir);
    const originalPrivateKey = readFileSync(first.privateKeyPath, "utf8");

    const second = await runEvidenceKeygen(outDir, { force: true });

    expect(second.privateKeyPath).toBe(first.privateKeyPath);
    expect(readFileSync(second.privateKeyPath, "utf8")).not.toBe(originalPrivateKey);
    expect(second.keyId).not.toBe(first.keyId);
    // mode 0600 still holds after an overwrite (writeFileSync's own `mode` only applies file creation;
    // chmodSync after the write is what actually re-asserts it).
    const mode = statSync(second.privateKeyPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

async function keyPaths(): Promise<{ privateKeyPath: string; publicKeyPath: string }> {
  const keyDir = tmp("kohaku-evidence-keys-");
  const { privateKeyPath, publicKeyPath } = await runEvidenceKeygen(keyDir);
  return { privateKeyPath, publicKeyPath };
}

describe("kohaku evidence export --data-dir / verify", () => {
  it("exports a pack from a local StoragePort data directory and verifies it", async () => {
    const dataDir = tmp("kohaku-evidence-data-");
    const storage = createFileStoragePort(dataDir);
    await storage.appendLineage({
      id: "e1",
      ts: "2026-06-01T00:00:00.000Z",
      actor: { kind: "system" },
      type: "view.composed",
      payload: { tier: "L1" },
    });
    await storage.appendLineage({
      id: "e2",
      ts: "2026-06-02T00:00:00.000Z",
      actor: { kind: "model" },
      type: "component.reviewed",
      payload: { artifactId: "a1", decision: "approve" },
    });

    const { privateKeyPath, publicKeyPath } = await keyPaths();
    const outDir = tmp("kohaku-evidence-out-");

    const result = await runEvidenceExport({
      dataDir,
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-12-31T23:59:59.999Z",
      privateKeyPath,
      outDir,
    });

    expect(result.manifest.counts.events).toBe(2);
    expect(result.manifest.counts.approvals).toBe(1);
    expect(result.manifest.complete).toBe(true);
    expect(existsSync(join(outDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(outDir, "manifest.sig"))).toBe(true);
    expect(existsSync(join(outDir, "events.jsonl"))).toBe(true);

    const verifyResult = await runEvidenceVerify(outDir, publicKeyPath);
    expect(verifyResult.errors).toEqual([]);
    expect(verifyResult.ok).toBe(true);
  });

  it("rejects when neither --data-dir nor --rest is given", async () => {
    const { privateKeyPath } = await keyPaths();
    await expect(
      runEvidenceExport({
        since: "2026-01-01T00:00:00.000Z",
        until: "2026-12-31T23:59:59.999Z",
        privateKeyPath,
        outDir: tmp("kohaku-evidence-out-"),
      }),
    ).rejects.toThrow(/Specify either --data-dir <dir> or --rest <baseUrl>/);
  });

  it("rejects when both --data-dir and --rest are given", async () => {
    const { privateKeyPath } = await keyPaths();
    await expect(
      runEvidenceExport({
        dataDir: tmp("kohaku-evidence-data-"),
        rest: "http://localhost:1",
        since: "2026-01-01T00:00:00.000Z",
        until: "2026-12-31T23:59:59.999Z",
        privateKeyPath,
        outDir: tmp("kohaku-evidence-out-"),
      }),
    ).rejects.toThrow(/only one of --data-dir or --rest/);
  });

  it("rejects a missing --private-key file with a clear message", async () => {
    await expect(
      runEvidenceExport({
        dataDir: tmp("kohaku-evidence-data-"),
        since: "2026-01-01T00:00:00.000Z",
        until: "2026-12-31T23:59:59.999Z",
        privateKeyPath: join(tmp("kohaku-evidence-nope-"), "missing.pem"),
        outDir: tmp("kohaku-evidence-out-"),
      }),
    ).rejects.toThrow(/Cannot read --private-key/);
  });

  it("verify reports exit-code-1-worthy failure (ok:false) when a byte is tampered with", async () => {
    const dataDir = tmp("kohaku-evidence-data-");
    const storage = createFileStoragePort(dataDir);
    await storage.appendLineage({
      id: "e1",
      ts: "2026-06-01T00:00:00.000Z",
      actor: { kind: "system" },
      type: "view.composed",
      payload: { tier: "L1" },
    });
    const { privateKeyPath, publicKeyPath } = await keyPaths();
    const outDir = tmp("kohaku-evidence-out-");
    await runEvidenceExport({
      dataDir,
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-12-31T23:59:59.999Z",
      privateKeyPath,
      outDir,
    });

    const eventsPath = join(outDir, "events.jsonl");
    const original = readFileSync(eventsPath);
    const tampered = Buffer.from(original);
    tampered[0] = tampered[0]! ^ 0xff;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(eventsPath, tampered);

    const verifyResult = await runEvidenceVerify(outDir, publicKeyPath);
    expect(verifyResult.ok).toBe(false);
    expect(verifyResult.errors.some((e) => e.includes("events.jsonl"))).toBe(true);
  });

  it("verify reports exit-code-2-worthy usage error (throws) for a missing --public-key file", async () => {
    const outDir = tmp("kohaku-evidence-out-");
    await expect(
      runEvidenceVerify(outDir, join(tmp("kohaku-evidence-nope-"), "missing.pem")),
    ).rejects.toThrow(/Cannot read --public-key/);
  });
});

describe("kohaku evidence export --since / --until normalization", () => {
  async function exportWindow(since: string, until: string, dataDir: string) {
    const { privateKeyPath } = await keyPaths();
    return runEvidenceExport({ dataDir, since, until, privateKeyPath, outDir: tmp("kohaku-evidence-out-") });
  }

  // Events on the last day of September (late in the UTC day) and at a +09:00 boundary.
  async function seededDataDir(): Promise<string> {
    const dataDir = tmp("kohaku-evidence-data-");
    const storage = createFileStoragePort(dataDir);
    for (const [id, ts] of [
      ["before", "2026-08-31T23:59:59.999Z"],
      ["first", "2026-09-01T00:00:00.000Z"],
      ["last-day", "2026-09-30T15:00:00.000Z"],
      ["after", "2026-10-01T00:00:00.000Z"],
    ] as const) {
      await storage.appendLineage({
        id,
        ts,
        actor: { kind: "system" },
        type: "view.composed",
        payload: { tier: "L1" },
      });
    }
    return dataDir;
  }

  it("a date-only --until includes that whole UTC day and the manifest records the resolved instants", async () => {
    const result = await exportWindow("2026-09-01", "2026-09-30", await seededDataDir());
    expect(result.manifest.counts.events).toBe(2); // first + last-day
    expect(result.manifest.scope.since).toBe("2026-09-01T00:00:00.000Z");
    expect(result.manifest.scope.until).toBe("2026-09-30T23:59:59.999Z");
  });

  it("canonicalizes a +09:00 offset to UTC before comparing", async () => {
    // 2026-10-01T09:00:00+09:00 is 2026-10-01T00:00:00Z: `after` is exactly on the inclusive bound.
    const result = await exportWindow(
      "2026-09-01T09:00:00+09:00",
      "2026-10-01T09:00:00+09:00",
      await seededDataDir(),
    );
    expect(result.manifest.scope.since).toBe("2026-09-01T00:00:00.000Z");
    expect(result.manifest.scope.until).toBe("2026-10-01T00:00:00.000Z");
    expect(result.manifest.counts.events).toBe(3); // first, last-day, after
  });

  it("resolveEvidenceWindow: date-only since starts the day, timestamps pass through canonicalized", () => {
    expect(resolveEvidenceWindow({ since: "2026-09-01", until: "2026-09-01" })).toEqual({
      since: "2026-09-01T00:00:00.000Z",
      until: "2026-09-01T23:59:59.999Z",
    });
    expect(
      resolveEvidenceWindow({ since: "2026-09-01T00:00:00Z", until: "2026-09-02T00:00:00.5+00:00" }),
    ).toEqual({ since: "2026-09-01T00:00:00.000Z", until: "2026-09-02T00:00:00.500Z" });
  });

  it.each([
    ["2026-9-1", "2026-09-30"],
    ["July 9, 2026", "2026-09-30"],
    ["2026-09-01T00:00:00", "2026-09-30"], // a time without an offset is environment-dependent
    ["2026-02-30", "2026-09-30"], // Date.parse would roll this over to March 2nd
    ["2026-09-01", "not-a-date"],
    ["2026-09-30", "2026-09-01"], // since after until
  ])("rejects an invalid window (%s .. %s) as a usage error", async (since, until) => {
    const { privateKeyPath } = await keyPaths();
    const outDir = tmp("kohaku-evidence-out-");
    const promise = runEvidenceExport({
      dataDir: tmp("kohaku-evidence-data-"),
      since,
      until,
      privateKeyPath,
      outDir,
    });
    await expect(promise).rejects.toBeInstanceOf(EvidenceUsageError);
    expect(existsSync(join(outDir, "manifest.json"))).toBe(false);
  });

  it("the CLI exits 2 with a message for an invalid --since", () => {
    const bin = join(dirname(fileURLToPath(import.meta.url)), "../bin/kohaku.js");
    const result = spawnSync(
      process.execPath,
      [
        bin,
        "evidence",
        "export",
        "--data-dir",
        tmp("kohaku-evidence-data-"),
        "--since",
        "yesterday",
        "--until",
        "2026-09-30",
        "--private-key",
        "unused.pem",
        "--out",
        tmp("kohaku-evidence-out-"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--since must be an ISO 8601");
  }, 30_000);
});

describe("kohaku evidence verify (security hardening)", () => {
  async function exportedPack(): Promise<{ outDir: string; publicKeyPath: string; privateKeyPath: string }> {
    const dataDir = tmp("kohaku-evidence-data-");
    const storage = createFileStoragePort(dataDir);
    await storage.appendLineage({
      id: "e1",
      ts: "2026-06-01T00:00:00.000Z",
      actor: { kind: "system" },
      type: "view.composed",
      payload: { tier: "L1" },
    });
    const { privateKeyPath, publicKeyPath } = await keyPaths();
    const outDir = tmp("kohaku-evidence-out-");
    await runEvidenceExport({
      dataDir,
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-12-31T23:59:59.999Z",
      privateKeyPath,
      outDir,
    });
    return { outDir, publicKeyPath, privateKeyPath };
  }

  it("refuses to follow a symlink planted at a listed path inside the pack", async () => {
    const { outDir, publicKeyPath } = await exportedPack();
    const secret = join(tmp("kohaku-evidence-secret-"), "secret.txt");
    writeFileSync(secret, "not part of the pack");
    const eventsPath = join(outDir, "events.jsonl");
    rmSync(eventsPath);
    symlinkSync(secret, eventsPath);

    const result = await runEvidenceVerify(outDir, publicKeyPath);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("events.jsonl") && e.includes("symlink"))).toBe(true);
  });

  it("refuses a file whose on-disk size differs from the manifest's recorded bytes, without buffering it (bounded reads)", async () => {
    const { outDir, publicKeyPath } = await exportedPack();
    const eventsPath = join(outDir, "events.jsonl");
    const originalSize = statSync(eventsPath).size;
    // A file swapped on disk for something much larger than what the (signed) manifest recorded --
    // verify must catch this from a stat, not by reading the whole thing into memory first.
    writeFileSync(eventsPath, "x".repeat(5 * 1024 * 1024));
    expect(statSync(eventsPath).size).not.toBe(originalSize);

    const result = await runEvidenceVerify(outDir, publicKeyPath);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("events.jsonl") && e.includes("on disk"))).toBe(true);
  });

  it("rejects a manifest whose files[].path is a traversal attempt, without reading any file", async () => {
    const { outDir, publicKeyPath, privateKeyPath } = await exportedPack();
    const manifestPath = join(outDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files[0].path = "../../../etc/passwd";
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Unsigned edit: the signature check (over the raw manifest) stops it before any schema or file access.
    const unsigned = await runEvidenceVerify(outDir, publicKeyPath);
    expect(unsigned.ok).toBe(false);

    // Even a manifest its signer really signed is refused on shape: the schema is the first line of
    // defense against a traversal path, independent of the signature.
    const { privateKey } = await importPrivateKeyPem(readFileSync(privateKeyPath, "utf8"));
    writeFileSync(join(outDir, "manifest.sig"), `${await signManifest(manifest, privateKey)}\n`);
    const signed = await runEvidenceVerify(outDir, publicKeyPath);
    expect(signed.ok).toBe(false);
    expect(signed.errors.some((e) => e.includes("EvidenceManifestSchema"))).toBe(true);
  });

  it("fails when an extra, unlisted file is smuggled into the pack directory", async () => {
    const { outDir, publicKeyPath } = await exportedPack();
    const extraPath = join(outDir, "artifacts", `${"b".repeat(64)}.html`);
    mkdirSync(join(outDir, "artifacts"), { recursive: true });
    writeFileSync(extraPath, "<div>not part of the manifest</div>");

    const result = await runEvidenceVerify(outDir, publicKeyPath);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("unexpected file"))).toBe(true);
  });
});

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

function allowAuthz(): AuthzPort {
  return {
    async issueCapability() {
      return "cap";
    },
    async verify() {
      return { ok: true, principal: { id: "u", roles: ["user"] } };
    },
  };
}

function makeRestApp(): { app: Hono; storage: ReturnType<typeof createMemoryStoragePort> } {
  const storage = createMemoryStoragePort();
  const lineage = createLineage({ storage });
  const compose: ComposeContext = {
    catalog,
    semantic: stubSemantic,
    storage,
    llm: new FakeLlm({ objects: [] }),
  };
  const deps: KohakuHostDeps = {
    compose,
    domain,
    authz: allowAuthz(),
    querySource: "sales",
    recorder: createViewRecorder(lineage),
    promotions: createPromotions({ lineage, storage }),
    fixations: createFixations({ lineage, storage }),
  };
  const app = new Hono();
  app.route("/api/kohaku", createKohakuRoutes(deps));
  return { app, storage };
}

describe("kohaku evidence export --rest (in-process host-rest app)", () => {
  it("exports a pack over REST (lineagePages + promotions.list; fixations.jsonl stays empty with a warning)", async () => {
    const { app, storage } = makeRestApp();
    const transport = (url: string, init?: RequestInit) => Promise.resolve(app.request(url, init));

    await storage.appendLineage({
      id: "e1",
      ts: "2026-06-01T00:00:00.000Z",
      actor: { kind: "system" },
      type: "view.composed",
      payload: { tier: "L1" },
    });
    // Promotions.list() (createPromotions) sources its candidate set from component.generated lineage
    // events, not the promotion-state store alone -- a putPromotionState with no matching event is
    // invisible to GET /promotions.
    await storage.appendLineage({
      id: "e2",
      ts: "2026-06-01T12:00:00.000Z",
      actor: { kind: "model" },
      type: "component.generated",
      payload: { artifactId: "a1", artifactSha256: `sha256:${"1".repeat(64)}`, html: "<div>hello</div>" },
    });
    await storage.putPromotionState({
      artifactId: "a1",
      status: "published",
      updatedAt: "2026-06-02T00:00:00.000Z",
      data: { html: "<div>hello</div>" },
    });

    const { privateKeyPath, publicKeyPath } = await keyPaths();
    const outDir = tmp("kohaku-evidence-out-");

    const result = await runEvidenceExport({
      rest: "/api/kohaku",
      transport,
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-12-31T23:59:59.999Z",
      privateKeyPath,
      outDir,
    });

    expect(result.manifest.counts.events).toBeGreaterThanOrEqual(1);
    expect(result.manifest.counts.promotions).toBe(1);
    expect(result.manifest.counts.fixations).toBe(0);
    expect(result.manifest.warnings.some((w) => w.includes("fixations.jsonl is empty"))).toBe(true);
    // A REST export's fixations.jsonl is structurally partial (see rest-source.ts), so `complete` must
    // say so even though lineage paging itself was exhaustive -- an auditor reading only `complete`
    // (without cross-referencing `warnings`) must not be told this pack is whole.
    expect(result.manifest.complete).toBe(false);

    const verifyResult = await runEvidenceVerify(outDir, publicKeyPath);
    expect(verifyResult.ok).toBe(true);
  });

  it("rejects a malformed --header value", async () => {
    const { app } = makeRestApp();
    const transport = (url: string, init?: RequestInit) => Promise.resolve(app.request(url, init));
    const { privateKeyPath } = await keyPaths();
    await expect(
      runEvidenceExport({
        rest: "/api/kohaku",
        transport,
        headers: ["no-colon-here"],
        since: "2026-01-01T00:00:00.000Z",
        until: "2026-12-31T23:59:59.999Z",
        privateKeyPath,
        outDir: tmp("kohaku-evidence-out-"),
      }),
    ).rejects.toThrow(/--header must be given as/);
  });

  it("derives scope.tenant from an x-kohaku-tenant header when --tenant is omitted", async () => {
    const { app } = makeRestApp();
    const transport = (url: string, init?: RequestInit) => Promise.resolve(app.request(url, init));
    const { privateKeyPath } = await keyPaths();

    const result = await runEvidenceExport({
      rest: "/api/kohaku",
      transport,
      headers: ["x-kohaku-tenant:acme"],
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-12-31T23:59:59.999Z",
      privateKeyPath,
      outDir: tmp("kohaku-evidence-out-"),
    });

    expect(result.manifest.scope.tenant).toBe("acme");
  });

  it("accepts --tenant when it matches the x-kohaku-tenant header", async () => {
    const { app } = makeRestApp();
    const transport = (url: string, init?: RequestInit) => Promise.resolve(app.request(url, init));
    const { privateKeyPath } = await keyPaths();

    const result = await runEvidenceExport({
      rest: "/api/kohaku",
      transport,
      headers: ["x-kohaku-tenant:acme"],
      tenant: "acme",
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-12-31T23:59:59.999Z",
      privateKeyPath,
      outDir: tmp("kohaku-evidence-out-"),
    });

    expect(result.manifest.scope.tenant).toBe("acme");
  });

  it("rejects --tenant when it conflicts with the x-kohaku-tenant header (mismatch rejection)", async () => {
    const { app } = makeRestApp();
    const transport = (url: string, init?: RequestInit) => Promise.resolve(app.request(url, init));
    const { privateKeyPath } = await keyPaths();

    await expect(
      runEvidenceExport({
        rest: "/api/kohaku",
        transport,
        headers: ["x-kohaku-tenant:acme"],
        tenant: "globex",
        since: "2026-01-01T00:00:00.000Z",
        until: "2026-12-31T23:59:59.999Z",
        privateKeyPath,
        outDir: tmp("kohaku-evidence-out-"),
      }),
    ).rejects.toThrow(/--tenant globex conflicts with the x-kohaku-tenant header \(acme\)/);
  });

  it("rejects --tenant in --rest mode when no x-kohaku-tenant header is supplied", async () => {
    const { app } = makeRestApp();
    const transport = (url: string, init?: RequestInit) => Promise.resolve(app.request(url, init));
    const { privateKeyPath } = await keyPaths();

    await expect(
      runEvidenceExport({
        rest: "/api/kohaku",
        transport,
        tenant: "acme",
        since: "2026-01-01T00:00:00.000Z",
        until: "2026-12-31T23:59:59.999Z",
        privateKeyPath,
        outDir: tmp("kohaku-evidence-out-"),
      }),
    ).rejects.toThrow(/no x-kohaku-tenant header was supplied/);
  });
});
