// @kohaku-ui/renderer-wc — the non-React reference renderer (Custom Elements v1 + Shadow DOM).
// A single <kohaku-surface> builds the entire UI Spec tree into one shadow root. The shared core is renderer-core.
// Dependency direction: spec-core → {registry, data-binding} → renderer-core → renderer-wc (sandbox is imported directly).

// UI message type and defaults (the single source of truth is renderer-core). Used to override context.messages.
// Governed actions (design.md #62/#63/#64): re-exported from renderer-core (the framework-free source of
// truth) so a consumer does not need to reach into @kohaku-ui/renderer-core directly for these.
export {
  type ActionManifest,
  type ActionManifestEntry,
  DEFAULT_MESSAGES,
  type PreflightActionResult,
  preflightAction,
  type RendererMessages,
  summarizeActionForModel,
} from "@kohaku-ui/renderer-core";
export { implementWc, type PartEntry, type TypedPartBuilder } from "./implement.js";
export { defineKohakuSurface, KOHAKU_EVENT, KohakuSurface } from "./kohaku-surface.js";
export { createCoreRenderRegistry } from "./registry.js";
export type {
  ActionPhase,
  PartBuilder,
  RenderRuntime,
  SurfaceContext,
  SurfaceEvent,
  Teardown,
} from "./types.js";
