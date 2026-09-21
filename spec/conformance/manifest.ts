/** Machine-readable conformance requirements table (paired with SPEC.md). */
export type RequirementLevel = "MUST" | "SHOULD";
export type RequirementTarget = "spec" | "rest-host" | "mcp-host" | "sandbox" | "lineage";

/**
 * Verification category:
 * - "blackbox": checked directly by the conformance suite (self / rest black-box).
 * - "reference": an internal invariant not amenable to black-box checking; guaranteed by the
 *   reference implementation's package tests (verifiedBy).
 *   Does not appear in the black-box suite results, but is not "unchecked" (reported separately as referenceVerifiedIds).
 */
export type RequirementVerification = "blackbox" | "reference";

export interface Requirement {
  id: string;
  level: RequirementLevel;
  target: RequirementTarget;
  description: string;
  verification: RequirementVerification;
  /** When verification is "reference", the location of the reference-implementation test that guarantees it. */
  verifiedBy?: string;
}

// biome-ignore format: one requirement per line keeps this table readable against spec/SPEC.md and
// keeps a requirement's diff to a single line. Several entries exceed any sensible line width, so
// the formatter would expand each one to six lines and the table would stop reading as a table.
export const REQUIREMENTS: Requirement[] = [
  // --- UI Spec format (self check) ----------------------------------------
  { id: "SPEC-ENV-001", level: "MUST", target: "spec", verification: "blackbox", description: "The envelope carries a kohaku version string" },
  { id: "SPEC-ENV-002", level: "MUST", target: "spec", verification: "blackbox", description: "intent.hash matches the sha256 of the canonical JSON" },
  { id: "SPEC-CMP-001", level: "MUST", target: "spec", verification: "blackbox", description: "components is a flat list with unique ids and a required root" },
  { id: "SPEC-CMP-002", level: "MUST", target: "spec", verification: "blackbox", description: "children form an acyclic DAG rooted at root" },
  { id: "SPEC-DATA-001", level: "MUST", target: "spec", verification: "blackbox", description: "Embedding bulk data is forbidden (pass by $ref only)" },
  { id: "SPEC-EVT-001", level: "MUST", target: "spec", verification: "blackbox", description: "The target component of each event exists" },
  { id: "SPEC-PATCH-001", level: "MUST", target: "spec", verification: "blackbox", description: "The diffSpec/applyPatch round-trip holds" },
  { id: "SPEC-STA-001", level: "MUST", target: "spec", verification: "blackbox", description: "state / visibleWhen / state.set declare kohaku>=0.2 and are reference-consistent (no STATE_REF_UNKNOWN/STATE_SET_INVALID)" },
  { id: "SPEC-STA-002", level: "MUST", target: "spec", verification: "blackbox", description: "data.bind declares kohaku>=0.2 and its initial variant is consistent (no BIND_STATE_UNKNOWN/BIND_PARAM_MISSING/BIND_VALUE_INVALID/BIND_PARAM_RESERVED/BIND_VARIANT_LIMIT)" },

  // --- Documentary norms not amenable to black-box checking (guaranteed by reference-implementation tests) ---
  { id: "SPEC-ENV-003", level: "MUST", target: "spec", verification: "reference", verifiedBy: "packages/renderer-wc/test/parity/structural.test.ts, packages/renderer-core/test/theme.test.ts", description: "A Spec carries no theme information; tokens are resolved on the Renderer side" },
  { id: "SPEC-EVT-002", level: "MUST", target: "spec", verification: "reference", verifiedBy: "packages/renderer-wc/test/parity/events.test.ts, packages/renderer-core/test/emit.test.ts", description: "The Renderer does not forward upstream any event not declared in the Spec's events" },
  { id: "SPEC-DATA-002", level: "MUST", target: "spec", verification: "reference", verifiedBy: "packages/renderer-wc/test/parity/spreadsheet-serverside.test.ts, packages/renderer-core/test/bound-data-controller.test.ts", description: "The Renderer reconciles a $ref's dataVersion per reference (refVersions?.[ref] ?? dataVersion) when refVersions is present" },
  { id: "CMP-DET-001", level: "MUST", target: "spec", verification: "reference", verifiedBy: "packages/composer/test/compose.test.ts, packages/composer/test/policy-fingerprint.test.ts", description: "For the same intentHash + dataVersion + catalogFingerprint, the host returns the same components/events (general form; REST-CMP-002 checks the black-box instance of this against a REST host)" },
  { id: "CMP-GEN-001", level: "MUST", target: "spec", verification: "reference", verifiedBy: "packages/composer/test/ref-constraint.test.ts, packages/composer/test/compose.test.ts", description: "A generated (L1) component's data.$ref is constrained to the resolved QueryHandle set, either at the schema stage (the default enum) or, under ComposePolicy.refConstraint=\"validate\", via explicit post-generation validation (DATA_REF_UNRESOLVED)" },
  // SPEC-A11Y-001 is SHOULD (not MUST), so it does not change the manifest's MUST count (spec/SPEC.md §7.1 / §7).
  { id: "SPEC-A11Y-001", level: "SHOULD", target: "spec", verification: "reference", verifiedBy: "packages/renderer-wc/test/parity/a11y.test.ts", description: "Every generated component's DOM passes axe-core's structural accessibility rules (ARIA validity, name/role/value semantics, labels, heading order, table headers, form-control labeling) in both renderers, over the golden Spec corpus (layout-dependent and page-level rules excluded; see axe-config.ts)" },

  // --- REST host (black-box check) -----------------------------------------
  { id: "REST-INT-001", level: "MUST", target: "rest-host", verification: "blackbox", description: "POST /intent/normalize returns an Intent with a hash" },
  { id: "REST-CMP-001", level: "MUST", target: "rest-host", verification: "blackbox", description: "POST /compose returns a §2-conformant spec and a capability" },
  { id: "REST-CMP-002", level: "MUST", target: "rest-host", verification: "blackbox", description: "Re-composing the same intent is a cache hit with identical components (determinism)" },
  { id: "REST-BND-001", level: "MUST", target: "rest-host", verification: "blackbox", description: "A binding resolve without a capability is 401" },
  { id: "REST-BND-002", level: "MUST", target: "rest-host", verification: "blackbox", description: "A valid capability returns a tabular envelope whose dataVersion matches the per-reference expected version (refVersions?.[ref] ?? dataVersion)" },
  { id: "REST-BND-003", level: "MUST", target: "rest-host", verification: "blackbox", description: "POST /binding/action without a capability is 401; with a valid capability that lacks the needed write scope (a read-only capability) it is 403" },
  { id: "REST-CAT-001", level: "MUST", target: "rest-host", verification: "blackbox", description: "GET /catalog returns the component definition list and a catalogVersion" },
  { id: "REST-EVT-001", level: "MUST", target: "rest-host", verification: "blackbox", description: "POST /events re-composes a declared event as an Intent diff" },
  { id: "REST-ERR-001", level: "MUST", target: "rest-host", verification: "blackbox", description: "POST /compose with an invalid body (non-JSON / both input and intent missing) is 400 with an {error:{code,message}} envelope" },
  { id: "REST-ERR-002", level: "SHOULD", target: "rest-host", verification: "blackbox", description: "GET /promotions and /fixations are either 200 with a {candidates}/{fixations} shape or a 501 NOT_IMPLEMENTED envelope" },
  { id: "REST-LIN-001", level: "SHOULD", target: "rest-host", verification: "blackbox", description: "GET /lineage has an {events:[]} shape and ?limit=1 returns ≤1 items" },
  { id: "REST-GOV-001", level: "SHOULD", target: "rest-host", verification: "blackbox", description: "POST /promotions/:id/actions returns 400 for an invalid payload and 404 for a valid action on an unknown artifact" },

  // --- Compose streaming (SPEC §6.1.1 [Draft]. SHOULD because the route itself is MAY) --------
  { id: "REST-STR-001", level: "SHOULD", target: "rest-host", verification: "blackbox", description: "POST /compose/stream begins with event: spec {spec, capability, final} whose spec is §2-conformant" },
  { id: "REST-STR-002", level: "SHOULD", target: "rest-host", verification: "blackbox", description: "The components/events resulting from applying patches match the non-streaming /compose (equivalence)" },
  { id: "REST-STR-003", level: "SHOULD", target: "rest-host", verification: "blackbox", description: "The stream terminates with exactly one event: done or event: error" },

  // --- MCP Apps host (guaranteed by reference-implementation tests) ---------
  { id: "MCPAPP-RES-001", level: "MUST", target: "mcp-host", verification: "reference", verifiedBy: "packages/host-mcp-apps/test", description: "A ui:// resource is text/html;profile=mcp-app" },
  { id: "MCPAPP-FBK-001", level: "MUST", target: "mcp-host", verification: "reference", verifiedBy: "packages/host-mcp-apps/test", description: "A tool result with UI has a non-empty text fallback" },
  { id: "MCPAPP-APP-001", level: "MUST", target: "mcp-host", verification: "reference", verifiedBy: "packages/host-mcp-apps/test", description: "The binding/event/action tools are ui/visibility=[app]" },
  { id: "MCPAPP-CAP-001", level: "MUST", target: "mcp-host", verification: "reference", verifiedBy: "packages/host-mcp-apps/test", description: "A compose-family tool result carries the capability token only in _meta[\"kohaku/capability\"], never in structuredContent" },

  // --- sandbox (guaranteed by reference-implementation tests) ---------------
  { id: "SBX-ATTR-001", level: "MUST", target: "sandbox", verification: "reference", verifiedBy: "packages/sandbox/test", description: "The L2 iframe sandbox attribute does not include allow-same-origin" },
  { id: "SBX-CSP-001", level: "MUST", target: "sandbox", verification: "reference", verifiedBy: "packages/sandbox/test", description: "The L2 document CSP includes connect-src 'none' and rejects every fetch directive (script-src/worker-src/child-src/img-src/etc.) naming an external origin" },
  { id: "SBX-EXEC-001", level: "MUST", target: "sandbox", verification: "reference", verifiedBy: "packages/sandbox/test", description: "Generated script runs in a dedicated Worker with no document/assignable location/window.open/importScripts/network access, and the applier rejects any element/attribute/style outside its allowlist" },
  { id: "SBX-NAV-001", level: "MUST", target: "sandbox", verification: "reference", verifiedBy: "packages/sandbox/test", description: "A navigation of the sandbox document is treated as a fault: the host tears the iframe down and does not let the guest continue running in the replaced document" },
  { id: "SBX-BRG-001", level: "MUST", target: "sandbox", verification: "reference", verifiedBy: "packages/sandbox/test", description: "A binding.fetch of an undeclared $ref is rejected with -32001" },
  // SPEC-KIT-001 is SHOULD (not MUST), so it does not change the manifest's MUST count (spec/SPEC.md §7).
  { id: "SPEC-KIT-001", level: "SHOULD", target: "sandbox", verification: "reference", verifiedBy: "packages/sandbox/test/mount.test.ts", description: "A sandbox mount that injects a versioned design-kit stylesheet (kit: {id, version, css}) compares it against Spec.provenance.kit and reports a mismatch via onTelemetry({kind:\"kit-mismatch\"}) rather than rendering unstyled markup silently; the mismatch is fail-open and never blocks rendering" },

  // --- lineage ----------------------------------------------------------------
  // LIN-PRM-001 is promoted to a black-box check of GET /lineage (a human component.reviewed(approve) precedes published in time order).
  { id: "LIN-PRM-001", level: "MUST", target: "lineage", verification: "blackbox", description: "A human component.reviewed(approve) exists before component.published" },
];
