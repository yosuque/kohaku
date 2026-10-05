/**
 * The Ports the framework defines and the product implements.
 * v0.1 extensions: SemanticPort.describeShape and StoragePort's lineage / promotion / fixation family.
 *
 * This file is the stable import path for the framework boundary: the package index, the docs and the
 * in-package deep imports all go through it. The definitions themselves live one file per Port under
 * `src/ports/` (DomainPort, SemanticPort, AuthzPort, ApprovalPort, StoragePort, RateLimitStore, and the
 * schema-suggestion / catalog-contribution wire types), and this barrel only re-exports them. The theme
 * token types are not a Port; they live in `theme-tokens.ts` and are re-exported here so every name that
 * was importable from this path stays importable from it.
 */

export * from "./ports/approval.js";
export * from "./ports/authz.js";
export * from "./ports/domain.js";
export * from "./ports/rate-limit.js";
export * from "./ports/semantic.js";
export * from "./ports/storage.js";
export * from "./ports/suggestion.js";
export * from "./theme-tokens.js";
