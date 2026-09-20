import type { AuthzPort, Principal, Scope, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CAPABILITY_TTL_SECONDS,
  issueCapabilityForSpec,
  issueSpecCapabilitySafely,
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

describe("issueSpecCapabilitySafely", () => {
  it("reports the error and issues fail-closed (empty allowed set) when allowedActions rejects", async () => {
    const issueCapability = vi.fn(
      async (_p: Principal, _s: Scope[], _o?: { ttlSeconds?: number }) => "cap-token",
    );
    const authz: AuthzPort = {
      issueCapability,
      async verify() {
        return { ok: true, principal: PRINCIPAL };
      },
    };
    const listOperationsError = new Error("listOperations failed");
    const allowedActions = vi.fn(async (): Promise<ReadonlySet<string>> => {
      throw listOperationsError;
    });
    const report = vi.fn();

    // No write (action.invoke) scope here on purpose: this spec's only scope is a read $ref, so the empty
    // allowed set from the rejection cannot additionally trigger onDroppedAction — report must be called
    // exactly once, for the rejection itself.
    const readOnlySpec: UISpec = {
      ...specWithRefAndAction(),
      events: [],
    };

    const token = await issueSpecCapabilitySafely(authz, PRINCIPAL, readOnlySpec, allowedActions, report);

    expect(token).toBe("cap-token");
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(listOperationsError);
    const [, scopes] = issueCapability.mock.calls[0]!;
    expect(scopes).not.toContainEqual({ kind: "write", ref: "sales.updateTarget" });
    expect(scopes).toContainEqual({ kind: "read", ref: "query://sales/summary?fy=2026" });
  });

  it("reports a WriteScopeDroppedError for an action.invoke ref outside allowedActions", async () => {
    const issueCapability = vi.fn(
      async (_p: Principal, _s: Scope[], _o?: { ttlSeconds?: number }) => "cap-token",
    );
    const authz: AuthzPort = {
      issueCapability,
      async verify() {
        return { ok: true, principal: PRINCIPAL };
      },
    };
    const allowedActions = vi.fn(async (): Promise<ReadonlySet<string>> => new Set(["a"]));
    const report = vi.fn();

    const spec = specWithRefAndAction();
    spec.events = [{ on: "root.submit", emit: "action.invoke", payload: { action: "b" } }];

    const token = await issueSpecCapabilitySafely(authz, PRINCIPAL, spec, allowedActions, report);

    expect(token).toBe("cap-token");
    expect(report).toHaveBeenCalledTimes(1);
    const [reportedError] = report.mock.calls[0]!;
    expect(reportedError).toBeInstanceOf(WriteScopeDroppedError);
    expect((reportedError as WriteScopeDroppedError).action).toBe("b");
  });

  it("passes ttlSeconds through to issueCapabilityForSpec", async () => {
    const issueCapability = vi.fn(
      async (_p: Principal, _s: Scope[], _o?: { ttlSeconds?: number }) => "cap-token",
    );
    const authz: AuthzPort = {
      issueCapability,
      async verify() {
        return { ok: true, principal: PRINCIPAL };
      },
    };
    const allowedActions = vi.fn(async (): Promise<ReadonlySet<string>> => new Set(["sales.updateTarget"]));
    const report = vi.fn();

    await issueSpecCapabilitySafely(authz, PRINCIPAL, specWithRefAndAction(), allowedActions, report, 120);

    const [, , opts] = issueCapability.mock.calls[0]!;
    expect(opts).toEqual({ ttlSeconds: 120 });
    expect(report).not.toHaveBeenCalled();
  });
});
