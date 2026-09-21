import {
  type CanonicalIntent,
  type ComponentNode,
  type EventBinding,
  parseSpec,
  SPEC_VERSION,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { COMPOSER_ID } from "./constants.js";
import type { ComposeContext } from "./context.js";
import { ComposeError } from "./errors.js";
import { postProcess } from "./post/index.js";
import type { ResolvedRefs } from "./refs.js";

/**
 * Returns the refVersions field for the Spec envelope if versionsByRef is non-empty.
 * Consolidates the conditional-spread boilerplate in one place (the key insertion order is determined by the caller's spread position).
 */
export function refVersionsField(
  refs: Pick<ResolvedRefs, "versionsByRef">,
): { refVersions: ResolvedRefs["versionsByRef"] } | Record<string, never> {
  return Object.keys(refs.versionsByRef).length > 0 ? { refVersions: refs.versionsByRef } : {};
}

export function assembleSpec(args: {
  intent: CanonicalIntent;
  refs: ResolvedRefs;
  components: ComponentNode[];
  events: EventBinding[];
  tier: "L0" | "L1" | "L2";
  cache: "miss" | "bypass";
  model?: string;
  /**
   * The state of `ComposePolicy.generatorVersion` / `designSystem?.kit` at composition time, stamped onto
   * `provenance` only when present (spec/SPEC.md §2.1 Appendix item 13, both MAY). `generatorVersion` and
   * `kit` (id/version only — the CSS itself lives on the render side) let a host tell an old L2 artifact
   * apart from a new one after either changes, without them the host has no way to distinguish a cached/
   * fixated artifact composed under a superseded kit from one composed under the current kit (M-1/M-2).
   * Stamped regardless of tier (including L0): kit identity is a property of when the markup was written,
   * not of how it was delivered.
   */
  generatorVersion?: string;
  kit?: { id: string; version: string };
  /**
   * The initial value of client-local state. Passed when the L0 fixed template has state.
   * Dropping it makes a template with visibleWhen fail structural validation with STATE_REF_UNKNOWN as
   * INTERNAL, or otherwise silently loses the initial state. Kept symmetric with materializeFixation (which preserves state via spread).
   */
  state?: UISpec["state"];
}): UISpec {
  return {
    kohaku: SPEC_VERSION,
    intent: args.intent,
    dataVersion: args.refs.dataVersion,
    // Always fill when there is at least one handle (put it in even for a single ref to unify the renderer-side version-matching logic)
    ...refVersionsField(args.refs),
    ...(args.state != null ? { state: args.state } : {}),
    components: args.components,
    events: args.events,
    provenance: {
      tier: args.tier,
      composedBy: COMPOSER_ID,
      ...(args.model != null ? { model: args.model } : {}),
      cache: args.cache,
      ...(args.generatorVersion != null ? { generatorVersion: args.generatorVersion } : {}),
      ...(args.kit != null ? { kit: args.kit } : {}),
    },
  };
}

/**
 * Deterministic post-processing (ID normalization, chart-kind rule, default sort, props normalization) +
 * final Spec validation. Routing composeStream's skeleton construction through the same path too makes the
 * component-version filling and props-default filling match the generated Spec.
 */
export function postAndValidate(spec: UISpec, refs: ResolvedRefs, ctx: ComposeContext): UISpec {
  const processed = postProcess(
    spec,
    { catalog: ctx.catalog, shapesByRef: refs.shapesByRef },
    ctx.policy?.extraRules ?? [],
  );
  try {
    // The JSON round trip is pre-processing, not a substitute for Zod parse: it drops the keys of undefined
    // values that postProcess's spread leaves and turns it into pure JSON. Because Zod keeps optional
    // undefined keys, this alone would diverge structurally from canonical JSON (the form for specHash
    // computation and wire transmission). Normalize first here so the validated Spec matches the stored/transmitted form.
    return parseSpec(JSON.parse(JSON.stringify(processed)));
  } catch (e) {
    throw new ComposeError("INTERNAL", "composed spec failed final validation", { cause: e });
  }
}

/**
 * Whether the Spec may be cache-stored. Do not store when bypass is specified.
 * Do not store a fallback Spec (error screen) either: prevents an error screen produced by a temporary LLM
 * failure from continuing to be delivered under the same key and getting entrenched even after recovery.
 * Because the L0 path structurally never becomes a fallback (provenance.fallback is always unset), this
 * common decision also matches the conventional "store unless bypass".
 */
export function shouldPersist(spec: UISpec, cacheMode: "default" | "bypass"): boolean {
  return cacheMode !== "bypass" && spec.provenance.fallback == null;
}

/**
 * Derives the delivered Spec's provenance.cache / trace.cache label from cacheMode. Kept as a single
 * derivation rather than a separately stored field on PreparedCompose, which would risk drifting out of sync.
 */
export function cacheLabelOf(cacheMode: "default" | "bypass"): "miss" | "bypass" {
  return cacheMode === "bypass" ? "bypass" : "miss";
}
