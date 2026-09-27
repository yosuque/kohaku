import { describeAuthzPortContract } from "@kohaku-ui/port-contracts";
import { createPlaygroundAuthzPort } from "../src/host/authz.js";

// The AuthzPort contract (spec-core ports.ts): exact-match scopes, tamper detection, expiry. No
// `revocation: true` here — this playground has no revocation store (see authz.ts's doc comment), so that
// part of the contract does not apply; `createPlaygroundAuthzPort` does not implement `revokeCapability`.
describeAuthzPortContract("playground (WebCrypto)", () => ({
  port: createPlaygroundAuthzPort("playground-test-secret"),
}));
