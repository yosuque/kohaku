import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKohakuMcpSetup } from "../src/setup.js";

/**
 * `createKohakuMcpSetup` now builds `McpHostDeps.resolvePrincipal` itself from the env-derived identity
 * resolver under `KOHAKU_AUTHZ=jwt` (previously only `http.ts`'s own `main()` did this, and only for the
 * real HTTP entry point -- untested). `@kohaku-ui/host-mcp-apps` is mocked here only to intercept the
 * `McpHostDeps` object `attachKohakuToMcpServer` receives, so `resolvePrincipal` itself can be exercised
 * directly against a synthetic `ServerContext` without standing up a real Streamable HTTP server (that path
 * is covered end-to-end by http-jwt.e2e.test.ts).
 */
vi.mock("@kohaku-ui/host-mcp-apps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kohaku-ui/host-mcp-apps")>();
  return { ...actual, attachKohakuToMcpServer: vi.fn(actual.attachKohakuToMcpServer) };
});

const SECRET = "test-secret-at-least-32-bytes-long-000";

async function jwt(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(SECRET));
}

function requestWithBearer(token?: string): { http: { req: Request } } {
  const headers: HeadersInit = token != null ? { authorization: `Bearer ${token}` } : {};
  return { http: { req: new Request("http://localhost/mcp", { headers }) } };
}

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
  vi.clearAllMocks();
});
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kohaku-mcp-jwt-"));
  tmpDirs.push(dir);
  return dir;
}

/** Grabs the McpHostDeps `resolvePrincipal` that `createKohakuMcpSetup`'s `createServer()` wired in. */
async function resolvePrincipalOf(setup: Awaited<ReturnType<typeof createKohakuMcpSetup>>) {
  const { attachKohakuToMcpServer } = await import("@kohaku-ui/host-mcp-apps");
  const mocked = vi.mocked(attachKohakuToMcpServer);
  mocked.mockClear();
  setup.createServer();
  const deps = mocked.mock.calls[0]![1];
  const resolvePrincipal = deps.resolvePrincipal;
  if (resolvePrincipal == null) throw new Error("resolvePrincipal was not wired");
  return resolvePrincipal;
}

describe("createKohakuMcpSetup: default resolvePrincipal under KOHAKU_AUTHZ=jwt", () => {
  it("no bearer token: rejects (fail-closed, MISSING_TOKEN)", async () => {
    process.env["KOHAKU_AUTHZ"] = "jwt";
    process.env["KOHAKU_JWT_SECRET"] = SECRET;
    process.env["KOHAKU_STORAGE"] = "memory";
    try {
      const setup = await createKohakuMcpSetup({ llm: new FakeLlm({ objects: [] }), dataDir: dataDir() });
      const resolvePrincipal = await resolvePrincipalOf(setup);
      await expect(resolvePrincipal(requestWithBearer() as never)).rejects.toMatchObject({
        code: "MISSING_TOKEN",
      });
    } finally {
      delete process.env["KOHAKU_AUTHZ"];
      delete process.env["KOHAKU_JWT_SECRET"];
      delete process.env["KOHAKU_STORAGE"];
    }
  });

  it("a valid HS256 token (32+ byte secret, audience) reaches the principal with its roles", async () => {
    process.env["KOHAKU_AUTHZ"] = "jwt";
    process.env["KOHAKU_JWT_SECRET"] = SECRET;
    process.env["KOHAKU_STORAGE"] = "memory";
    try {
      const setup = await createKohakuMcpSetup({ llm: new FakeLlm({ objects: [] }), dataDir: dataDir() });
      const resolvePrincipal = await resolvePrincipalOf(setup);
      const token = await jwt({ sub: "u1", roles: ["admin"], tenant: "acme" });
      const principal = await resolvePrincipal(requestWithBearer(token) as never);
      expect(principal).toMatchObject({ id: "u1", roles: ["admin"] });
    } finally {
      delete process.env["KOHAKU_AUTHZ"];
      delete process.env["KOHAKU_JWT_SECRET"];
      delete process.env["KOHAKU_STORAGE"];
    }
  });

  it("options.resolvePrincipal overrides the env-derived default", async () => {
    process.env["KOHAKU_AUTHZ"] = "jwt";
    process.env["KOHAKU_JWT_SECRET"] = SECRET;
    process.env["KOHAKU_STORAGE"] = "memory";
    try {
      const override = vi.fn(async () => ({ id: "overridden" }));
      const setup = await createKohakuMcpSetup({
        llm: new FakeLlm({ objects: [] }),
        dataDir: dataDir(),
        resolvePrincipal: override,
      });
      const resolvePrincipal = await resolvePrincipalOf(setup);
      expect(resolvePrincipal).toBe(override);
    } finally {
      delete process.env["KOHAKU_AUTHZ"];
      delete process.env["KOHAKU_JWT_SECRET"];
      delete process.env["KOHAKU_STORAGE"];
    }
  });

  it("no KohakuMcpSetup.identity is exposed any more (setup.ts owns resolvePrincipal wiring end to end)", async () => {
    const setup = await createKohakuMcpSetup({ llm: new FakeLlm({ objects: [] }), dataDir: dataDir() });
    expect("identity" in setup).toBe(false);
  });
});

describe("createKohakuMcpSetup: options.storage overrides env entirely", () => {
  it("ready()/close() are no-ops for the injected storage, and KOHAKU_STORAGE is never read (an invalid value would otherwise throw)", async () => {
    process.env["KOHAKU_STORAGE"] = "dynamo"; // would throw if createStorageFromEnv were ever called
    try {
      const { createMemoryStoragePort } = await import("@kohaku-ui/storage-memory");
      const setup = await createKohakuMcpSetup({
        llm: new FakeLlm({ objects: [] }),
        dataDir: dataDir(),
        storage: createMemoryStoragePort(),
        authz: (await import("@kohaku-ui/authz-hmac")).createHmacAuthzPort("test-secret"),
      });
      await expect(setup.ready()).resolves.toBeUndefined();
      await expect(setup.close()).resolves.toBeUndefined();
    } finally {
      delete process.env["KOHAKU_STORAGE"];
    }
  });
});
