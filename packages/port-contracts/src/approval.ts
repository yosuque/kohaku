import type { ApprovalPort } from "@kohaku-ui/spec-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContractFixture } from "./storage.js";

export interface ApprovalContractOptions {
  /** "fake" (default) drives expiry with vi.setSystemTime; "real" waits ~1.1s of wall clock instead. */
  clock?: "fake" | "real";
  /**
   * Opts into the single-use (replay) case, for a port configured with an `ApprovalStore`. Explicit
   * rather than feature-detected, the same reasoning as `AuthzContractOptions.revocation`: a port that
   * cannot enforce single-use should not silently pass a suite that never exercised it.
   */
  singleUse?: boolean;
}

const ACTION = "annotate";
const PAYLOAD_HASH = `sha256:${"a".repeat(64)}`;
const REQUESTER_ID = "contract-requester";
const APPROVER_ID = "contract-approver";

/**
 * The ApprovalPort contract (spec-core ports.ts): exact binding (action, payloadHash, requester,
 * tenant), self-approval rejection, tamper detection, and expiry. Registers one `describe` block; call
 * it at the top level of a vitest file.
 */
export function describeApprovalPortContract<P extends ApprovalPort = ApprovalPort>(
  name: string,
  factory: () => Promise<ContractFixture<P>> | ContractFixture<P>,
  options: ApprovalContractOptions = {},
): void {
  const clock = options.clock ?? "fake";

  describe(`ApprovalPort contract: ${name}`, () => {
    let fixture: ContractFixture<P>;
    let approvals: P;

    beforeEach(async () => {
      if (clock === "fake") {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      }
      fixture = await factory();
      approvals = fixture.port;
    });

    afterEach(async () => {
      await fixture.dispose?.();
      if (clock === "fake") vi.useRealTimers();
    });

    it("verifies a token for exactly the binding it was issued for", async () => {
      const token = await approvals.issueApproval({
        action: ACTION,
        payloadHash: PAYLOAD_HASH,
        requesterId: REQUESTER_ID,
        approverId: APPROVER_ID,
      });
      const result = await approvals.verifyApproval(token, {
        action: ACTION,
        payloadHash: PAYLOAD_HASH,
        requesterId: REQUESTER_ID,
      });
      expect(result.ok).toBe(true);
      expect(result.grant?.approverId).toBe(APPROVER_ID);
      expect(result.grant?.requesterId).toBe(REQUESTER_ID);
    });

    it("rejects issuing a self-approval (approverId === requesterId)", async () => {
      await expect(
        approvals.issueApproval({
          action: ACTION,
          payloadHash: PAYLOAD_HASH,
          requesterId: "same-person",
          approverId: "same-person",
        }),
      ).rejects.toThrow();
    });

    it("does not verify against a different action, payload hash, requester, or tenant", async () => {
      const token = await approvals.issueApproval({
        action: ACTION,
        payloadHash: PAYLOAD_HASH,
        requesterId: REQUESTER_ID,
        approverId: APPROVER_ID,
        tenant: "tenant-a",
      });
      expect(
        (
          await approvals.verifyApproval(token, {
            action: "delete",
            payloadHash: PAYLOAD_HASH,
            requesterId: REQUESTER_ID,
            tenant: "tenant-a",
          })
        ).ok,
      ).toBe(false);
      expect(
        (
          await approvals.verifyApproval(token, {
            action: ACTION,
            payloadHash: `sha256:${"b".repeat(64)}`,
            requesterId: REQUESTER_ID,
            tenant: "tenant-a",
          })
        ).ok,
      ).toBe(false);
      expect(
        (
          await approvals.verifyApproval(token, {
            action: ACTION,
            payloadHash: PAYLOAD_HASH,
            requesterId: "someone-else",
            tenant: "tenant-a",
          })
        ).ok,
      ).toBe(false);
      expect(
        (
          await approvals.verifyApproval(token, {
            action: ACTION,
            payloadHash: PAYLOAD_HASH,
            requesterId: REQUESTER_ID,
            tenant: "tenant-b",
          })
        ).ok,
      ).toBe(false);
    });

    it("rejects a tampered or malformed token", async () => {
      const token = await approvals.issueApproval({
        action: ACTION,
        payloadHash: PAYLOAD_HASH,
        requesterId: REQUESTER_ID,
        approverId: APPROVER_ID,
      });
      const tampered = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`;
      const req = { action: ACTION, payloadHash: PAYLOAD_HASH, requesterId: REQUESTER_ID };
      expect((await approvals.verifyApproval(tampered, req)).ok).toBe(false);
      expect((await approvals.verifyApproval("not-a-token", req)).ok).toBe(false);
    });

    it("rejects an expired approval", async () => {
      const token = await approvals.issueApproval(
        { action: ACTION, payloadHash: PAYLOAD_HASH, requesterId: REQUESTER_ID, approverId: APPROVER_ID },
        { ttlSeconds: 1 },
      );
      const req = { action: ACTION, payloadHash: PAYLOAD_HASH, requesterId: REQUESTER_ID };
      expect((await approvals.verifyApproval(token, req)).ok).toBe(true);
      if (clock === "fake") vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
      else await new Promise((resolve) => setTimeout(resolve, 1100));
      expect((await approvals.verifyApproval(token, req)).ok).toBe(false);
    });

    if (options.singleUse) {
      it("denies a second verification of the same token (single-use enforcement)", async () => {
        const token = await approvals.issueApproval({
          action: ACTION,
          payloadHash: PAYLOAD_HASH,
          requesterId: REQUESTER_ID,
          approverId: APPROVER_ID,
        });
        const req = { action: ACTION, payloadHash: PAYLOAD_HASH, requesterId: REQUESTER_ID };
        expect((await approvals.verifyApproval(token, req)).ok).toBe(true);
        expect((await approvals.verifyApproval(token, req)).ok).toBe(false);
      });
    }
  });
}
