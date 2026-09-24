// Re-exported for convenience: a caller injecting a custom revocations store (options.revocations)
// needs the interface, and this keeps it reachable from the same package as the option it configures.
// The type is defined in @kohaku-ui/spec-core (see ports.ts for why); this is a type-only re-export,
// not a second definition.
export type { CapabilityRevocationStore } from "@kohaku-ui/spec-core";
export {
  createHmacAuthzPort,
  DEFAULT_CAPABILITY_TTL_SECONDS,
  type HmacAuthzOptions,
  type HmacAuthzPort,
  type RevokeCapabilityResult,
} from "./hmac-authz-port.js";
export { createMemoryRevocationStore } from "./revocation.js";
