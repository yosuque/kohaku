// Re-exported from host-rest so a project that wires `routes.authorizeGovernance` (as `kohaku init`'s generated
// server/ports.ts shows in a commented block) needs no extra dependency.
export { createGovernancePolicy, governancePolicyFromRoles } from "@kohaku-ui/host-rest";
export { type CreateKohakuHostOptions, createKohakuHost, type KohakuHost } from "./create-host.js";
