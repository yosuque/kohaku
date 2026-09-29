// Re-exported for convenience: a caller injecting a custom revocations store (options.revocations)
// needs the interface, and this keeps it reachable from the same package as the option it configures.
// The type is defined in @kohaku-ui/spec-core (see ports.ts for why); this is a type-only re-export,
// not a second definition.
export type { ApprovalStore, CapabilityRevocationStore } from "@kohaku-ui/spec-core";
export { createMemoryApprovalStore } from "./approval-store.js";
export {
  createHmacApprovalPort,
  DEFAULT_APPROVAL_TTL_SECONDS,
  DEFAULT_MAX_APPROVAL_TTL_SECONDS,
  type HmacApprovalOptions,
} from "./hmac-approval-port.js";
export {
  createHmacAuthzPort,
  DEFAULT_CAPABILITY_TTL_SECONDS,
  type HmacAuthzOptions,
  type HmacAuthzPort,
  type RevokeCapabilityResult,
} from "./hmac-authz-port.js";
export { createMemoryRevocationStore, type MemoryRevocationStoreTestHooks } from "./revocation.js";
