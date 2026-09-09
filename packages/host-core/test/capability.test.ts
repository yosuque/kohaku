import type { AuthzPort, Principal, Scope, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CAPABILITY_TTL_SECONDS,
  issueCapabilityForSpec,
  WriteScopeDroppedError,
} from "../src/capability.js";

const PRINCIPAL: Principal = { id: "u1", roles: ["user"] };

function specWithRefAndAction(): UISpec {
  return {
    kohaku: "0.1",
    intent: { canonical: "sales.trend", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "v1",
    components: [
      {
        id: "root",
        type: "layout.stack",
        props: {},
        children: ["table"],
      },
      {
        id: "table",
        type: "presentTable",
        props: {},
        data: { $ref: "query://sales/summary?fy=2026" },
      },
    ],
    events: [{ on: "root.submit", emit: "action.invoke", payload: { action: "sales.updateTarget" } }],
    provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
  };
}

describe("issueCapabilityForSpec", () => {
  it("collects read + write scopes from the spec and issues via AuthzPort", async () => {
    const issueCapability = vi.fn(
      async (_p: Principal, _s: Scope[], _o?: { ttlSeconds?: number }) => "cap-token",
    );
    const authz: AuthzPort = {
      issueCapability,
      async verify() {
        return { ok: true, principal: PRINCIPAL };
      },
    };
    const token = await issueCapabilityForSpec(authz, PRINCIPAL, specWithRefAndAction());
    expect(token).toBe("cap-token");
    expect(issueCapability).toHaveBeenCalledTimes(1);
    const [principalArg, scopes, opts] = issueCapability.mock.calls[0]!;
    expect(principalArg).toBe(PRINCIPAL);
    expect(scopes).toEqual(
      expect.arrayContaining([
        { kind: "read", ref: "query://sales/summary?fy=2026" },
        { kind: "write", ref: "sales.updateTarget" },
      ]),
    );
    expect(opts).toEqual({ ttlSeconds: DEFAULT_CAPABILITY_TTL_SECONDS });
  });

  it("defaults the TTL to 600 seconds", () => {
    expect(DEFAULT_CAPABILITY_TTL_SECONDS).toBe(600);
  });

  it("passes an explicit ttlSeconds through instead of the default", async () => {
    const issueCapability = vi.fn(
      async (_p: Principal, _s: Scope[], _o?: { ttlSeconds?: number }) => "cap-token",
    );
    const authz: AuthzPort = {
      issueCapability,
      async verify() {
        return { ok: true, principal: PRINCIPAL };
      },
    };
    await issueCapabilityForSpec(authz, PRINCIPAL, specWithRefAndAction(), 120);
    const [, , opts] = issueCapability.mock.calls[0]!;
    expect(opts).toEqual({ ttlSeconds: 120 });
  });

  it("drops write scopes whose action is not in allowedActions and reports each via onDroppedAction", async () => {
    const issueCapability = vi.fn(
      async (_p: Principal, _s: Scope[], _o?: { ttlSeconds?: number }) => "cap-token",
    );
    const authz: AuthzPort = {
      issueCapability,
      async verify() {
        return { ok: true, principal: PRINCIPAL };
      },
    };
    const dropped: string[] = [];
    await issueCapabilityForSpec(authz, PRINCIPAL, specWithRefAndAction(), undefined, {
      allowedActions: new Set(),
      onDroppedAction: (action) => dropped.push(action),
    });
    const [, scopes] = issueCapability.mock.calls[0]!;
    expect(scopes).not.toContainEqual({ kind: "write", ref: "sales.updateTarget" });
    expect(scopes).toContainEqual({ kind: "read", ref: "query://sales/summary?fy=2026" });
    expect(dropped).toEqual(["sales.updateTarget"]);
  });

  it("leaves write scopes untouched when allowedActions is undefined", async () => {
    const issueCapability = vi.fn(
      async (_p: Principal, _s: Scope[], _o?: { ttlSeconds?: number }) => "cap-token",
    );
    const authz: AuthzPort = {
      issueCapability,
      async verify() {
        return { ok: true, principal: PRINCIPAL };
      },
    };
    await issueCapabilityForSpec(authz, PRINCIPAL, specWithRefAndAction());
    const [, scopes] = issueCapability.mock.calls[0]!;
    expect(scopes).toContainEqual({ kind: "write", ref: "sales.updateTarget" });
  });

  it("never drops read scopes even with an empty allowedActions", async () => {
    const issueCapability = vi.fn(
      async (_p: Principal, _s: Scope[], _o?: { ttlSeconds?: number }) => "cap-token",
    );
    const authz: AuthzPort = {
      issueCapability,
      async verify() {
        return { ok: true, principal: PRINCIPAL };
      },
    };
    await issueCapabilityForSpec(authz, PRINCIPAL, specWithRefAndAction(), undefined, {
      allowedActions: new Set(),
    });
    const [, scopes] = issueCapability.mock.calls[0]!;
    expect(scopes).toContainEqual({ kind: "read", ref: "query://sales/summary?fy=2026" });
  });

  it("WriteScopeDroppedError carries the dropped action name", () => {
    const err = new WriteScopeDroppedError("sales.updateTarget");
    expect(err.action).toBe("sales.updateTarget");
    expect(err.name).toBe("WriteScopeDroppedError");
    expect(err.message).toContain("sales.updateTarget");
  });
});
