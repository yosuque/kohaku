import type { ComposeContext } from "@kohaku-ui/composer";
import type { AuthzPort, DomainPort, JsonObject } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps } from "../src/index.js";

// /binding/action does not reference compose, so a ComposeContext stub suffices.
const NO_COMPOSE = {} as unknown as ComposeContext;

/** An authz that allows everything (write-scope verification is done on the routes side, so pass here). */
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

/** A domain that echoes the write. */
function echoDomain(): DomainPort {
  return {
    async listOperations() {
      return [];
    },
    async invoke(op: string, args: JsonObject) {
      return { ok: true, op, args };
    },
  };
}

function baseDeps(extra?: Partial<KohakuHostDeps>): KohakuHostDeps {
  return {
    compose: NO_COMPOSE,
    domain: echoDomain(),
    authz: allowAuthz(),
    querySource: "sales",
    ...extra,
  };
}

async function postAction(deps: KohakuHostDeps, body: unknown, auth = true) {
  const app = createKohakuRoutes(deps);
  return app.request("/binding/action", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: "Bearer cap" } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("response shape of POST /binding/action", () => {
  it("returns {result} only when actionEffects is not wired (backward compatible)", async () => {
    const res = await postAction(baseDeps(), { action: "annotate", payload: { note: "hi" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ result: { ok: true, op: "annotate", args: { note: "hi" } } });
    expect(body).not.toHaveProperty("invalidates");
    expect(body).not.toHaveProperty("refVersions");
  });

  it("returns {result, invalidates, refVersions} when actionEffects is wired", async () => {
    const REF = "query://sales/summary?fy=2026";
    const deps = baseDeps({
      actionEffects: async (action, payload, result) => {
        expect(action).toBe("annotate");
        expect(payload).toEqual({ note: "hi", refs: [REF] });
        expect(result).toMatchObject({ ok: true });
        return { invalidates: [REF], refVersions: { [REF]: "v2" } };
      },
    });
    const res = await postAction(deps, { action: "annotate", payload: { note: "hi", refs: [REF] } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["result"]).toMatchObject({ ok: true });
    expect(body["invalidates"]).toEqual([REF]);
    expect(body["refVersions"]).toEqual({ [REF]: "v2" });
  });

  it("even when actionEffects throws, the write succeeds (200 {result} only) and the failure goes to the observability hook", async () => {
    // domain.invoke (the write) already succeeded. Turning a side-effect declaration (actionEffects) failure into a
    // 404 would make the client resend and could duplicate a non-idempotent write. Place the effects failure on the observability hook and return a success response.
    const seen: { endpoint: string; requestId: string; error: unknown }[] = [];
    const deps = baseDeps({
      actionEffects: async () => {
        throw new Error("effects computation failed (test)");
      },
      onError: (info) => {
        seen.push(info);
      },
    });
    const res = await postAction(deps, { action: "annotate", payload: { note: "hi" } });
    // The write is treated as committed: return 200 with only {result} (the backward-compatible shape).
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ result: { ok: true, op: "annotate", args: { note: "hi" } } });
    expect(body).not.toHaveProperty("invalidates");
    expect(body).not.toHaveProperty("refVersions");
    // The effects failure is notified to the observability hook (endpoint = binding/action.effects, distinguishing it from a write failure).
    expect(seen).toHaveLength(1);
    expect(seen[0]!.endpoint).toBe("binding/action.effects");
    expect(seen[0]!.error).toBeInstanceOf(Error);
  });

  it("failure of domain.invoke (the write itself) is 404 (distinguished from effects failure)", async () => {
    const throwingDomain: DomainPort = {
      async listOperations() {
        return [];
      },
      async invoke() {
        throw new Error("write failed (test)");
      },
    };
    const seen: { endpoint: string }[] = [];
    const deps = baseDeps({
      domain: throwingDomain,
      onError: (info) => {
        seen.push({ endpoint: info.endpoint });
      },
    });
    const res = await postAction(deps, { action: "annotate", payload: {} });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("REF_NOT_FOUND");
    // A failure of the write itself is endpoint = binding/action (distinguishable from effects).
    expect(seen).toHaveLength(1);
    expect(seen[0]!.endpoint).toBe("binding/action");
  });

  it("returns 401 when there is no capability", async () => {
    const res = await postAction(baseDeps(), { action: "annotate", payload: {} }, false);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CAPABILITY_REQUIRED");
  });

  it("a non-object payload (array/string) is rejected with 400 BAD_REQUEST", async () => {
    const arrayRes = await postAction(baseDeps(), { action: "annotate", payload: ["nope"] });
    expect(arrayRes.status).toBe(400);
    expect(((await arrayRes.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");

    const stringRes = await postAction(baseDeps(), { action: "annotate", payload: "nope" });
    expect(stringRes.status).toBe(400);
  });

  it("outside the write scope is 403 (authz.verify rejects)", async () => {
    const denyAuthz: AuthzPort = {
      async issueCapability() {
        return "cap";
      },
      async verify() {
        return { ok: false, reason: "scope does not cover write" };
      },
    };
    const res = await postAction(baseDeps({ authz: denyAuthz }), { action: "annotate", payload: {} });
    expect(res.status).toBe(403);
  });

  it("verify ok without a principal is 403 when deps.auth is wired (guards against silently acting as ANONYMOUS)", async () => {
    const authzOkNoPrincipal: AuthzPort = {
      async issueCapability() {
        return "cap";
      },
      async verify() {
        return { ok: true };
      },
    };
    const deps = baseDeps({ authz: authzOkNoPrincipal, auth: async () => ({ id: "u", roles: ["user"] }) });
    const res = await postAction(deps, { action: "annotate", payload: {} });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CAPABILITY_DENIED");
  });

  it("verify ok without a principal still falls back to ANONYMOUS when deps.auth is unwired (unauthenticated demo path)", async () => {
    const authzOkNoPrincipal: AuthzPort = {
      async issueCapability() {
        return "cap";
      },
      async verify() {
        return { ok: true };
      },
    };
    const res = await postAction(baseDeps({ authz: authzOkNoPrincipal }), {
      action: "annotate",
      payload: {},
    });
    expect(res.status).toBe(200);
  });

  it("a thrown authz.verify (infrastructure failure) is 503 INTERNAL, reported to onError, without invoking domain", async () => {
    const seen: { endpoint: string; requestId: string; error: unknown }[] = [];
    const throwingAuthz: AuthzPort = {
      async issueCapability() {
        return "cap";
      },
      async verify() {
        throw new Error("revocation store unavailable (test)");
      },
    };
    const invokeCalls: { op: string }[] = [];
    const deps = baseDeps({
      authz: throwingAuthz,
      domain: {
        async listOperations() {
          return [];
        },
        async invoke(op: string, args: JsonObject) {
          invokeCalls.push({ op });
          return { ok: true, op, args };
        },
      },
      onError: (info) => {
        seen.push(info);
      },
    });
    const res = await postAction(deps, { action: "annotate", payload: {} });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe("capability verification unavailable");
    expect(invokeCalls).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.endpoint).toBe("binding/action");
    expect(seen[0]!.error).toBeInstanceOf(Error);
  });
});
