import type { AuthzPort } from "@kohaku-ui/spec-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContractFixture } from "./storage.js";

/** A concrete port that also exposes pre-expiry revocation (e.g. HmacAuthzPort / JwtAuthzPort). */
export type RevocableAuthzPort = AuthzPort & {
  revokeCapability(token: string): Promise<{ ok: true } | { ok: false; reason: string }>;
};

export interface AuthzContractOptions {
  /** "fake" (default) drives expiry with vi.setSystemTime; "real" waits ~1.1s of wall clock instead. */
  clock?: "fake" | "real";
  /**
   * Opts into the revocation case. Explicit rather than feature-detected (`"revokeCapability" in port`):
   * a guard like that would silently produce a zero-assertion passing test for any port that omits the
   * method, which is exactly the mistake this repository's port-contracts suites have made once before.
   * When true, the factory must actually return a `RevocableAuthzPort` (a port missing the method fails
   * the test at call time rather than being silently skipped).
   */
  revocation?: boolean;
}

/**
 * The AuthzPort contract (spec-core ports.ts): exact-match scopes, tamper detection, expiry.
 * Registers one `describe` block; call it at the top level of a vitest file.
 */
export function describeAuthzPortContract<P extends AuthzPort = AuthzPort>(
  name: string,
  factory: () => Promise<ContractFixture<P>> | ContractFixture<P>,
  options: AuthzContractOptions = {},
): void {
  const clock = options.clock ?? "fake";
  const principal = { id: "contract-user", roles: ["user"] };

  describe(`AuthzPort contract: ${name}`, () => {
    let fixture: ContractFixture<P>;
    let authz: P;

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

    if (options.revocation) {
      it("reports ok:false once a verified capability has been revoked", async () => {
        const revocable = authz as unknown as RevocableAuthzPort;
        const cap = await revocable.issueCapability(principal, [{ kind: "read", ref: "query://s/x" }]);
        expect((await revocable.verify(cap, { kind: "read", ref: "query://s/x" })).ok).toBe(true);

        const revokeResult = await revocable.revokeCapability(cap);
        expect(revokeResult.ok).toBe(true);

        expect((await revocable.verify(cap, { kind: "read", ref: "query://s/x" })).ok).toBe(false);
      });
    }
  });
}
