import type { ComposeContext } from "@kohaku-ui/composer";
import type { AuthzPort, DomainPort, JsonObject } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps } from "../src/index.js";

// GET /binding/resolve does not reference compose, so a ComposeContext stub suffices.
const NO_COMPOSE = {} as unknown as ComposeContext;

describe("reserved parameters / base-ref verification of GET /binding/resolve", () => {
  // The capability allows by prefix match against the base ref (without reserved params). Confirms that scope
  // cannot be bypassed with reserved params (verification is done against base).
  const ALLOWED = "query://sales/records?fy=2026";

  function harness() {
    const verifiedRefs: string[] = [];
    const invokeCalls: { op: string; args: JsonObject }[] = [];
    const authz: AuthzPort = {
      async issueCapability() {
        return "cap";
      },
      async verify(_token, req) {
        verifiedRefs.push(req.ref);
        return req.ref.startsWith(ALLOWED)
          ? { ok: true, principal: { id: "u", roles: ["user"] } }
          : { ok: false, reason: "out of scope" };
      },
    };
    const domain: DomainPort = {
      async listOperations() {
        return [];
      },
      async invoke(op: string, args: JsonObject) {
        invokeCalls.push({ op, args });
        return { columns: [], rows: [], dataVersion: "v1" };
      },
    };
    const deps: KohakuHostDeps = { compose: NO_COMPOSE, domain, authz, querySource: "sales" };
    return { deps, verifiedRefs, invokeCalls };
  }

  async function get(deps: KohakuHostDeps, ref: string, auth = true) {
    const app = createKohakuRoutes(deps);
    return app.request(`/binding/resolve?ref=${encodeURIComponent(ref)}`, {
      headers: auth ? { authorization: "Bearer cap" } : {},
    });
  }

  it("even for a ref with reserved parameters, verifies the capability against the base and merges reserved into domain", async () => {
    const { deps, verifiedRefs, invokeCalls } = harness();
    // Holds only the base (fy=2026) capability, but sends a paging request that adds _limit/_cursor/_sort/_dir.
    const res = await get(
      deps,
      "query://sales/records?_cursor=100:v1&_dir=desc&_limit=50&_sort=revenue&fy=2026",
    );
    expect(res.status).toBe(200);
    // capability verification is done against the base ref (with reserved params removed).
    expect(verifiedRefs).toEqual(["query://sales/records?fy=2026"]);
    // domain.invoke is passed base.params + reserved merged (the `_` namespace convention; DomainPort unchanged).
    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0]!.op).toBe("records");
    expect(invokeCalls[0]!.args).toEqual({
      fy: "2026",
      _cursor: "100:v1",
      _dir: "desc",
      _limit: "50",
      _sort: "revenue",
    });
  });

  it("an unknown `_` parameter is 400 BAD_REQUEST (only known reserved keys are allowed)", async () => {
    const { deps, invokeCalls } = harness();
    // Since the reserved namespace is outside capability verification, passing an unknown key through to domain
    // would let the data range be changed with an unauthorized parameter. Reject anything outside the allowlist (_cursor/_limit/_sort/_dir).
    const res = await get(deps, "query://sales/records?_tenant=other&fy=2026");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
    expect(invokeCalls).toHaveLength(0);
  });

  it("a normal ref without reserved parameters is verified and invoked against the base (regression)", async () => {
    const { deps, verifiedRefs, invokeCalls } = harness();
    const res = await get(deps, "query://sales/records?fy=2026");
    expect(res.status).toBe(200);
    expect(verifiedRefs).toEqual(["query://sales/records?fy=2026"]);
    expect(invokeCalls[0]!.args).toEqual({ fy: "2026" });
  });

  it("if the base ref is out of scope it is 403 (scope cannot be bypassed with reserved parameters)", async () => {
    const { deps } = harness();
    // The fy=2025 base is not a prefix match of ALLOWED (fy=2026) -> 403.
    const res = await get(deps, "query://sales/records?_limit=50&fy=2025");
    expect(res.status).toBe(403);
  });

  // Characterization (pre-refactor): the querySource mismatch check runs before capability verification /
  // domain.invoke, and short-circuits both. Locks this order down before the parse/merge step moves to
  // host-core's parseInvokableRef.
  it("a ref whose source does not match querySource is 404 SOURCE_MISMATCH, without verifying or invoking", async () => {
    const { deps, verifiedRefs, invokeCalls } = harness();
    const res = await get(deps, "query://other/records?fy=2026");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("SOURCE_MISMATCH");
    expect(verifiedRefs).toHaveLength(0);
    expect(invokeCalls).toHaveLength(0);
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
    const invokeCalls: { op: string; args: JsonObject }[] = [];
    const deps: KohakuHostDeps = {
      compose: NO_COMPOSE,
      domain: {
        async listOperations() {
          return [];
        },
        async invoke(op: string, args: JsonObject) {
          invokeCalls.push({ op, args });
          return { columns: [], rows: [], dataVersion: "v1" };
        },
      },
      authz: throwingAuthz,
      querySource: "sales",
      onError: (info) => {
        seen.push(info);
      },
    };
    const res = await get(deps, "query://sales/records?fy=2026");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe("capability verification unavailable");
    expect(invokeCalls).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.endpoint).toBe("binding/resolve");
    expect(seen[0]!.error).toBeInstanceOf(Error);
  });
});
