import type { ResolvedCatalog } from "@kohaku-ui/registry";
import type { DataShape, UISpec } from "@kohaku-ui/spec-core";

export interface PostProcessContext {
  catalog: ResolvedCatalog;
  /** query:// URI → column metadata (empty if there is no SemanticPort.describeShape) */
  shapesByRef: Map<string, DataShape>;
}

/**
 * A deterministic post-processing rule. Must be a pure function and idempotent.
 * Layout rules such as chart kind and sort order are applied in code rather than left to the LLM.
 */
export type PostRule = (spec: UISpec, ctx: PostProcessContext) => UISpec;
