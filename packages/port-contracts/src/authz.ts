import type { AuthzPort } from "@kohaku-ui/spec-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContractFixture } from "./storage.js";

export interface AuthzContractOptions {
  /** "fake" (default) drives expiry with vi.setSystemTime; "real" waits ~1.1s of wall clock instead. */
  clock?: "fake" | "real";
}

/**
 * The AuthzPort contract (spec-core ports.ts): exact-match scopes, tamper detection, expiry.
 * Registers one `describe` block; call it at the top level of a vitest file.
 */
export function describeAuthzPortContract(
  name: string,
  factory: () => Promise<ContractFixture<AuthzPort>> | ContractFixture<AuthzPort>,
  options: AuthzContractOptions = {},
): void {
  const clock = options.clock ?? "fake";
  const principal = { id: "contract-user", roles: ["user"] };

  describe(`AuthzPort contract: ${name}`, () => {
    let fixture: ContractFixture<AuthzPort>;
    let authz: AuthzPort;

    beforeEach(async () => {
      if (clock === "fake") {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      }
      fixture = await factory();
      authz = fixture.port;
    });

    afterEach(async () => {
      await fixture.dispose?.();
      if (clock === "fake") vi.useRealTimers();
    });

    it("verifies a capability for exactly the issued scope and returns the principal", async () => {
      const cap = await authz.issueCapability(principal, [
        { kind: "read", ref: "query://s/summary?region=us" },
      ]);
      const result = await authz.verify(cap, { kind: "read", ref: "query://s/summary?region=us" });
      expect(result.ok).toBe(true);
      expect(result.principal?.id).toBe(principal.id);
    });

    it("matches refs exactly (no prefix match across value or name boundaries)", async () => {
      const cap = await authz.issueCapability(principal, [
        { kind: "read", ref: "query://s/summary?region=us" },
        { kind: "write", ref: "annotate" },
      ]);
      expect((await authz.verify(cap, { kind: "read", ref: "query://s/summary?region=usa" })).ok).toBe(false);
      expect((await authz.verify(cap, { kind: "write", ref: "annotateAll" })).ok).toBe(false);
    });

    it("does not let a read scope satisfy a write request for the same ref", async () => {
      const cap = await authz.issueCapability(principal, [{ kind: "read", ref: "annotate" }]);
      expect((await authz.verify(cap, { kind: "write", ref: "annotate" })).ok).toBe(false);
    });

    it("rejects a tampered or malformed token", async () => {
      const cap = await authz.issueCapability(principal, [{ kind: "read", ref: "query://s/x" }]);
      const tampered = `${cap.slice(0, -2)}${cap.endsWith("AA") ? "BB" : "AA"}`;
      expect((await authz.verify(tampered, { kind: "read", ref: "query://s/x" })).ok).toBe(false);
      expect((await authz.verify("not-a-token", { kind: "read", ref: "query://s/x" })).ok).toBe(false);
    });

    it("rejects an expired capability", async () => {
      const cap = await authz.issueCapability(principal, [{ kind: "read", ref: "query://s/x" }], {
        ttlSeconds: 1,
      });
      expect((await authz.verify(cap, { kind: "read", ref: "query://s/x" })).ok).toBe(true);
      if (clock === "fake") vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
      else await new Promise((resolve) => setTimeout(resolve, 1100));
      expect((await authz.verify(cap, { kind: "read", ref: "query://s/x" })).ok).toBe(false);
    });
  });
}
