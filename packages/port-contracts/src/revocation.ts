import type { CapabilityRevocationStore } from "@kohaku-ui/spec-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContractFixture } from "./storage.js";

/**
 * The CapabilityRevocationStore contract (spec-core ports.ts). Asserts only what the plan specifies:
 * inside the validity window `isRevoked` is true, and an unregistered jti is false. Expired-entry
 * behavior is deliberately left unspecified (a store may drop the entry or keep it around), so this
 * suite does not assert either way -- pinning one would fail a legitimate implementation that chose
 * the other.
 * Registers one `describe` block; call it at the top level of a vitest file.
 */
export function describeRevocationStoreContract(
  name: string,
  factory: () =>
    | Promise<ContractFixture<CapabilityRevocationStore>>
    | ContractFixture<CapabilityRevocationStore>,
): void {
  describe(`CapabilityRevocationStore contract: ${name}`, () => {
    let fixture: ContractFixture<CapabilityRevocationStore>;
    let store: CapabilityRevocationStore;

    beforeEach(async () => {
      fixture = await factory();
      store = fixture.port;
    });

    afterEach(async () => {
      await fixture.dispose?.();
    });

    it("reports a jti as revoked while inside its validity window", async () => {
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await store.revoke("contract-jti", expiresAt);
      expect(await store.isRevoked("contract-jti")).toBe(true);
    });

    it("reports an unregistered jti as not revoked", async () => {
      expect(await store.isRevoked("contract-never-registered-jti")).toBe(false);
    });
  });
}
