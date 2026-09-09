// The pure resolution functions for two-way binding live in spec-core (environment-neutral, the source of truth).
// We re-export them so host / renderer can consume them via data-binding (centralizing the import path).
export { enumerateBindVariants, resolveBoundRef } from "@kohaku-ui/spec-core";
export {
  type AbortSignalLike,
  type ActionFetcher,
  type ActionOptions,
  type ActionResult,
  type BindingClient,
  type BindingClientConfig,
  type BindingFetcher,
  createBindingClient,
  type FetchResponseLike,
  formatQueryRef,
  parseQueryRef,
  type QueryRef,
  QueryRefError,
  RESERVED_PARAM_PREFIX,
  type ResolveOptions,
  type SplitRef,
  splitReservedParams,
} from "./client.js";
export { BindingError, type BindingErrorCode } from "./errors.js";
export { assertKnownReservedParams, KNOWN_RESERVED_PARAMS } from "./query-ref.js";
