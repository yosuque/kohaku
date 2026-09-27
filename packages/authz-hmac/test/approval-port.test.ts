import type { ApprovalStore } from "@kohaku-ui/spec-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmacApprovalPort, createHmacAuthzPort, createMemoryApprovalStore } from "../src/index.js";

const REQ = { action: "annotate", payloadHash: "sha256:" + "a".repeat(64), requesterId: "requester-1" };

describe("createHmacApprovalPort issuance", () => {
  it("issues a token that verifies against the exact binding it was granted for", async () => {
    const approvals = createHmacApprovalPort("test-secret");
    const token = await approvals.issueApproval({
      action: REQ.action,
      payloadHash: REQ.payloadHash,
      requesterId: REQ.requesterId,
      approverId: "approver-1",
    });
    const result = await approvals.verifyApproval(token, REQ);
    expect(result.ok).toBe(true);
    expect(result.grant?.approverId).toBe("approver-1");
    expect(result.grant?.requesterId).toBe(REQ.requesterId);
  });

  it("rejects issuing a self-approval (approverId === requesterId)", async () => {
    const approvals = createHmacApprovalPort("test-secret");
    await expect(
      approvals.issueApproval({
        action: REQ.action,
        payloadHash: REQ.payloadHash,
        requesterId: "same-person",
        approverId: "same-person",
      }),
    ).rejects.toThrow(/approverId must differ from requesterId/);
  });
});

describe("createHmacApprovalPort binding checks", () => {
  async function issue(overrides: { tenant?: string } = {}) {
    const approvals = createHmacApprovalPort("test-secret");
    const token = await approvals.issueApproval({
      action: REQ.action,
      payloadHash: REQ.payloadHash,
      requesterId: REQ.requesterId,
      approverId: "approver-1",
      ...overrides,
    });
    return { approvals, token };
  }

  it("rejects a token presented for a different action", async () => {
    const { approvals, token } = await issue();
    const result = await approvals.verifyApproval(token, { ...REQ, action: "delete" });
    expect(result).toEqual({ ok: false, reason: "approval is bound to a different action" });
  });

  it("rejects a token presented for a different payload hash", async () => {
    const { approvals, token } = await issue();
    const result = await approvals.verifyApproval(token, {
      ...REQ,
      payloadHash: "sha256:" + "b".repeat(64),
    });
    expect(result).toEqual({ ok: false, reason: "approval is bound to a different payload" });
  });

  it("rejects a token presented for a different requester", async () => {
    const { approvals, token } = await issue();
    const result = await approvals.verifyApproval(token, { ...REQ, requesterId: "someone-else" });
    expect(result).toEqual({ ok: false, reason: "approval is bound to a different requester" });
  });

  it("rejects a token presented for a different tenant", async () => {
    const { approvals, token } = await issue({ tenant: "tenant-a" });
    const result = await approvals.verifyApproval(token, { ...REQ, tenant: "tenant-b" });
    expect(result).toEqual({ ok: false, reason: "approval is bound to a different tenant" });
  });

  it("accepts a matching tenant, and treats an unspecified tenant on both sides as matching", async () => {
    const { approvals: withTenant, token: tokenWithTenant } = await issue({ tenant: "tenant-a" });
    expect((await withTenant.verifyApproval(tokenWithTenant, { ...REQ, tenant: "tenant-a" })).ok).toBe(true);

    const { approvals: noTenant, token: tokenNoTenant } = await issue();
    expect((await noTenant.verifyApproval(tokenNoTenant, REQ)).ok).toBe(true);
  });

  it("treats an empty-string tenant as distinct from an unspecified tenant, in both directions", async () => {
    // Cross-language parity regression: TS's `claims.tenant ?? undefined` only normalizes null/undefined,
    // never a falsy-but-present empty string, so tenant: "" and an unset tenant must never match each other.
    const { approvals: emptyTenant, token: tokenEmptyTenant } = await issue({ tenant: "" });
    const emptyVsUnset = await emptyTenant.verifyApproval(tokenEmptyTenant, REQ);
    expect(emptyVsUnset).toEqual({ ok: false, reason: "approval is bound to a different tenant" });

    const { approvals: noTenant, token: tokenNoTenant } = await issue();
    const unsetVsEmpty = await noTenant.verifyApproval(tokenNoTenant, { ...REQ, tenant: "" });
    expect(unsetVsEmpty).toEqual({ ok: false, reason: "approval is bound to a different tenant" });

    // tenant: "" on both sides still matches (it is a real, if unusual, tenant value).
    const bothEmpty = await emptyTenant.verifyApproval(tokenEmptyTenant, { ...REQ, tenant: "" });
    expect(bothEmpty.ok).toBe(true);
  });
});

describe("createHmacApprovalPort expiry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is rejected as expired once its ttlSeconds has elapsed (exp <= now)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const approvals = createHmacApprovalPort("test-secret", { ttlSeconds: 1 });
    const token = await approvals.issueApproval({
      action: REQ.action,
      payloadHash: REQ.payloadHash,
      requesterId: REQ.requesterId,
      approverId: "approver-1",
    });

    expect((await approvals.verifyApproval(token, REQ)).ok).toBe(true);

    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    const result = await approvals.verifyApproval(token, REQ);
    expect(result).toEqual({ ok: false, reason: "approval expired" });
  });

  it("uses the default TTL (DEFAULT_APPROVAL_TTL_SECONDS = 300) when none is given", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const approvals = createHmacApprovalPort("test-secret");
    const token = await approvals.issueApproval({
      action: REQ.action,
      payloadHash: REQ.payloadHash,
      requesterId: REQ.requesterId,
      approverId: "approver-1",
    });

    vi.setSystemTime(new Date("2026-01-01T00:04:59.000Z")); // 299s later: still valid
    expect((await approvals.verifyApproval(token, REQ)).ok).toBe(true);

    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z")); // 300s later: expired
    expect((await approvals.verifyApproval(token, REQ)).ok).toBe(false);
  });
});

describe("createHmacApprovalPort domain separation from capability tokens", () => {
  it("rejects a capability token presented as an approval token", async () => {
    const authz = createHmacAuthzPort("test-secret");
    const approvals = createHmacApprovalPort("test-secret");
    const cap = await authz.issueCapability({ id: "u" }, [{ kind: "write", ref: "annotate" }]);

    const result = await approvals.verifyApproval(cap, REQ);
    expect(result.ok).toBe(false);
  });

  it("rejects an approval token presented as a capability", async () => {
    const authz = createHmacAuthzPort("test-secret");
    const approvals = createHmacApprovalPort("test-secret");
    const token = await approvals.issueApproval({
      action: REQ.action,
      payloadHash: REQ.payloadHash,
      requesterId: REQ.requesterId,
      approverId: "approver-1",
    });

    const result = await authz.verify(token, { kind: "write", ref: "annotate" });
    expect(result.ok).toBe(false);
  });
});

describe("createHmacApprovalPort with an ApprovalStore (single-use enforcement)", () => {
  it("without a store configured, a token can be verified more than once before it expires", async () => {
    const approvals = createHmacApprovalPort("test-secret");
    const token = await approvals.issueApproval({
      action: REQ.action,
      payloadHash: REQ.payloadHash,
      requesterId: REQ.requesterId,
      approverId: "approver-1",
    });
    expect((await approvals.verifyApproval(token, REQ)).ok).toBe(true);
    expect((await approvals.verifyApproval(token, REQ)).ok).toBe(true);
  });

  it("with a store configured, a second verification of the same token is denied (replay)", async () => {
    const store = createMemoryApprovalStore();
    const approvals = createHmacApprovalPort("test-secret", { store });
    const token = await approvals.issueApproval({
      action: REQ.action,
      payloadHash: REQ.payloadHash,
      requesterId: REQ.requesterId,
      approverId: "approver-1",
    });
    expect((await approvals.verifyApproval(token, REQ)).ok).toBe(true);
    const second = await approvals.verifyApproval(token, REQ);
    expect(second).toEqual({ ok: false, reason: "approval already used" });
  });

  it("a request that fails a binding check never consumes the store (no use spent on a denial anyway)", async () => {
    const calls: string[] = [];
    const store: ApprovalStore = {
      async consume(jti) {
        calls.push(jti);
        return true;
      },
    };
    const approvals = createHmacApprovalPort("test-secret", { store });
    const token = await approvals.issueApproval({
      action: REQ.action,
      payloadHash: REQ.payloadHash,
      requesterId: REQ.requesterId,
      approverId: "approver-1",
    });
    const result = await approvals.verifyApproval(token, { ...REQ, action: "delete" });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("an ApprovalStore failure propagates as a thrown error (fail-closed), for an otherwise-valid token", async () => {
    const store: ApprovalStore = {
      async consume() {
        throw new Error("approval store unavailable (test)");
      },
    };
    const approvals = createHmacApprovalPort("test-secret", { store });
    const token = await approvals.issueApproval({
      action: REQ.action,
      payloadHash: REQ.payloadHash,
      requesterId: REQ.requesterId,
      approverId: "approver-1",
    });
    await expect(approvals.verifyApproval(token, REQ)).rejects.toThrow("approval store unavailable (test)");
  });
});

describe("createMemoryApprovalStore", () => {
  it("consume() returns true on first use and false on a second use for the same jti", async () => {
    const store = createMemoryApprovalStore();
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(await store.consume("jti-1", nowSeconds + 60)).toBe(true);
    expect(await store.consume("jti-1", nowSeconds + 60)).toBe(false);
  });

  it("sweeps expired entries so a stale jti does not grow the map forever", async () => {
    let now = 1000;
    const store = createMemoryApprovalStore(() => now);
    expect(await store.consume("jti-1", 1010)).toBe(true);
    now = 1011; // jti-1's own record has now expired
    // A fresh jti still consumes fine after the sweep (unrelated to the expired one).
    expect(await store.consume("jti-2", 1100)).toBe(true);
  });
});
