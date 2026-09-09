import type { JsonObject, JsonValue } from "@kohaku-ui/spec-core";
import type { z } from "zod";

/** Capability declaration: the events a part can fire, whether it needs data, whether it allows children, etc. */
export interface CapabilityDecl {
  /** Names of events the part can fire ("rowClick", etc.; used to validate the Spec's events[].on) */
  events: string[];
  data: "none" | "optional" | "required";
  children: "none" | "optional";
  /** Has a write path (presentForm / editable spreadsheet) */
  editable?: boolean;
  /** When omitted, available on all surfaces */
  surfaces?: string[];
}

/**
 * Implementation kind. native requires an implementation registered on the renderer side.
 * sandbox-template is typed, version-managed parameterized HTML whose rendering still happens inside
 * the sandbox (the default output of an L2→L1 promotion — promotion means coming under governance, not
 * a rewrite into a native implementation).
 */
export type ImplementationDecl = { kind: "native" } | { kind: "sandbox-template"; html: string };

export interface FallbackDecl {
  /** The part type to downgrade to. The end of the chain is presentMarkdown (the principle that a text fallback is mandatory). */
  type: string;
  mapProps: (props: JsonObject) => JsonObject;
}

export interface GoldenFixtureRef {
  fixture: string;
}

/* zod 4's ZodObject has a default generic argument, so it can be used without type arguments */
export interface ComponentDefinition<P extends z.ZodObject = z.ZodObject> {
  type: string;
  version: string;
  /** Selection guidance for the LLM (transcribed into the generation prompt) */
  description: string;
  /** Zod is the source of truth. The JSON Schema is derived. */
  propsSchema: P;
  capabilities: CapabilityDecl;
  implementation?: ImplementationDecl;
  fallback?: FallbackDecl;
  golden?: GoldenFixtureRef[];
  examples?: { intent: string; props: JsonObject }[];
  /**
   * Whether to include this in the L1 generation vocabulary (default "allowed").
   * An "excluded" part drops out of buildGenerationSchema's variants and the generation prompt's
   * enumeration, so the LLM cannot output the part structurally (used for runtime-only parts such as
   * ui.loading).
   */
  generation?: "allowed" | "excluded";
}

/** The range already implemented on the renderer (surface) side. Used by negotiate. */
export interface SurfaceCapabilities {
  /** type → semver range */
  supports: Record<string, string>;
  features?: string[];
  maxTier?: "L0" | "L1" | "L2";
}

export interface CatalogIssue {
  code:
    | "UNKNOWN_TYPE"
    | "PROPS_INVALID"
    | "DATA_REQUIRED"
    | "DATA_FORBIDDEN"
    | "EVENT_NOT_SUPPORTED"
    | "CHILDREN_NOT_SUPPORTED";
  componentId: string;
  message: string;
}

export type PropsJsonSchema = JsonValue;
