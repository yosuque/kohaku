import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { UISpec } from "@kohaku-ui/spec-core";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

// e2e for the sample-api wiring of the governance plane's declarative RBAC:
// the role derived from the x-kohaku-role header (admin / reviewer / viewer) branches authorization on governance routes.
// No header (default) is treated as admin, preserving the legacy demo behavior.

function makeMemoryStorage() {
  const cache = new Map<string, UISpec>();
  return {
    async getSpecCache(key: string) {
      return cache.get(key) ?? null;
    },
    async putSpecCache(key: string, spec: UISpec) {
      cache.set(key, spec);
    },
    async appendLineage() {},
    async listLineage() {
      return [];
    },
    async getPromotionState() {
      return null;
    },
    async putPromotionState() {},
    async listPromotionStates() {
      return [];
    },
    async getFixation() {
      return null;
    },
    async putFixation() {},
    async listFixations() {
      return [];
    },
  };
}

async function makeApp(): Promise<Hono> {
  const llm = new FakeLlm({ objects: [] });
  const authz = createHmacAuthzPort("test-secret");
  return (await createApp({ llm, storage: makeMemoryStorage(), authz })).app;
}

function req(app: Hono, method: "GET" | "POST", path: string, role?: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      ...(role != null ? { "x-kohaku-role": role } : {}),
    },
    ...(method === "POST" && body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const draft = {
  componentType: "sales.customX",
  version: "1.0.0",
  intentName: "sales.custom_x",
  description: "test draft",
};

describe("governance plane RBAC (sample-api wiring. #1)", () => {
  it("viewer passes reads (GET /lineage) but approve/delete operations return 403 CAPABILITY_DENIED", async () => {
    const app = await makeApp();

    // Reads are allowed.
    expect((await req(app, "GET", "/api/kohaku/lineage", "viewer")).status).toBe(200);

    // Promotion approve is denied by authorization (stops at 403 before the downstream artifact lookup 404).
    const approve = await req(app, "POST", "/api/kohaku/promotions/nope/approve", "viewer", { draft });
    expect(approve.status).toBe(403);
    expect(((await approve.json()) as { error: { code: string } }).error.code).toBe("CAPABILITY_DENIED");

    // Preview is also denied by authorization (viewer lacks promotion.preview — issuing a data read
    // capability is not opened to the viewer role).
    const preview = await req(app, "POST", "/api/kohaku/promotions/nope/preview", "viewer");
    expect(preview.status).toBe(403);

    // Fixation removal is also denied by authorization.
    const remove = await req(app, "POST", "/api/kohaku/fixations/sha256:abc/remove", "viewer");
    expect(remove.status).toBe(403);
  });

  it("admin (default / no header) passes authorization (unknown artifact yields a downstream 404 = evidence the gate passed)", async () => {
    const app = await makeApp();

    // Explicit admin.
    const explicit = await req(app, "POST", "/api/kohaku/promotions/nope/approve", "admin", { draft });
    expect(explicit.status).toBe(404);

    // No header (default admin) behaves the same. Does not become 403 (regression of the legacy demo behavior).
    const implicit = await req(app, "POST", "/api/kohaku/promotions/nope/approve", undefined, { draft });
    expect(implicit.status).toBe(404);
  });

  it("reviewer passes promotion operations but fixation delete returns 403 (out of scope)", async () => {
    const app = await makeApp();

    // reviewer has promotion.*, so approve passes authorization -> 404 for the unknown artifact.
    const approve = await req(app, "POST", "/api/kohaku/promotions/nope/approve", "reviewer", { draft });
    expect(approve.status).toBe(404);

    // preview is also included in promotion.* and passes authorization -> 404 for the unknown artifact (evidence the gate was passed).
    const preview = await req(app, "POST", "/api/kohaku/promotions/nope/preview", "reviewer");
    expect(preview.status).toBe(404);

    // fixation.remove is outside reviewer's permissions -> 403.
    const remove = await req(app, "POST", "/api/kohaku/fixations/sha256:abc/remove", "reviewer");
    expect(remove.status).toBe(403);
  });

  it("the demo bump-data-version route shares the same RBAC (admin.bumpDataVersion: admin only)", async () => {
    const app = await makeApp();

    // admin (default / no header) is authorized (admin's "*" pattern covers admin.bumpDataVersion too).
    const asAdmin = await req(app, "POST", "/api/kohaku/admin/bump-data-version", "admin");
    expect(asAdmin.status).toBe(200);

    // reviewer holds only promotion.* / lineage.read / analytics.read -> denied.
    const asReviewer = await req(app, "POST", "/api/kohaku/admin/bump-data-version", "reviewer");
    expect(asReviewer.status).toBe(403);

    // viewer is likewise denied.
    const asViewer = await req(app, "POST", "/api/kohaku/admin/bump-data-version", "viewer");
    expect(asViewer.status).toBe(403);
    expect(((await asViewer.json()) as { error: { code: string } }).error.code).toBe("CAPABILITY_DENIED");
  });
});
