import type { JsonObject, JsonValue, ThemeTokens } from "@kohaku-ui/spec-core";

/** The artifact of freely generated L2 HTML. Its sha256 is verified before mount. */
export interface SandboxArtifact {
  inline: string;
  sha256: string;
}

/**
 * The parent-side bridge. Capability tokens never enter the iframe at all —
 * the parent proxies data resolution through this function (the adopted answer: capabilities stay in the parent, and bulk
 * data is passed by reference rather than through the guest's context).
 */
export interface SandboxBridge {
  /** Resolves data for a declared $ref (the allowlist check is done on the sandbox side) */
  resolveBinding(ref: string): Promise<JsonValue>;
  /** Forwards a declared event upstream (into the Composition loop) */
  onEvent(event: { componentId: string; on: string; payload: JsonObject }): void;
  onTelemetry?(event: SandboxTelemetryEvent): void;
}

export interface SandboxTelemetryEvent {
  componentId: string;
  /**
   * `kit-mismatch`: the resolved `kit`'s `{id, version}` (see `MountSandboxOptions.kit`) disagrees with
   * `provenanceKit` (the `Spec.provenance.kit` the markup was actually written against). Fail-open —
   * reported for observability only; rendering proceeds unchanged (SPEC-KIT-001, spec/SPEC.md §2.1).
   */
  kind: "ready" | "error" | "fetch" | "denied" | "kit-mismatch";
  detail?: string;
}

export interface SandboxPolicy {
  /**
   * The in-document meta CSP (default: complete network blocking). Not a full replacement but a validated composition:
   * blocking directives (default-src / connect-src / form-action / base-uri / object-src / frame-src) cannot be relaxed
   * below the default (specifying a relaxation makes resolvePolicy throw). Fetch directives (img-src / font-src /
   * media-src / script-src / style-src / worker-src / child-src / manifest-src / prefetch-src, and their -elem/-attr
   * variants) are restrict-only: every source token must stay inside the closed area ('none' / data: / blob: /
   * 'unsafe-inline' / 'unsafe-eval' / 'unsafe-hashes' / nonce- and sha256- family keyword sources — 'self' is rejected too,
   * since it is meaningless under the sandbox's opaque origin), so a product cannot open e.g. `img-src https:` and
   * turn it into an exfiltration channel. A handful of directives with no network implication (sandbox /
   * upgrade-insecure-requests / block-all-mixed-content / require-trusted-types-for / trusted-types) pass through
   * unvalidated. Everything else, including report-uri / report-to (would exfiltrate CSP reports) and navigate-to
   * (not a real directive), is rejected outright. This prevents a single relaxed directive from erasing the second
   * layer of the triple defense.
   */
  csp?: string;
  bootTimeoutMs?: number;
  rpcTimeoutMs?: number;
  fetchesPerMinute?: number;
  maxConcurrentFetches?: number;
  maxPayloadBytes?: number;
  maxHtmlBytes?: number;
  maxHeightPx?: number;
  /** Per-minute limit for event.emit (recompose-storm suppression) */
  eventsPerMinute?: number;
  /** Per-minute limit for telemetry.report (log-bloat suppression) */
  telemetryPerMinute?: number;
  /** Per-minute limit for ui.resize (resize rapid-fire suppression) */
  resizesPerMinute?: number;
  /** Payload limit for event.emit (JSON string length) */
  maxEventPayloadBytes?: number;
  /**
   * DOM-shape limits enforced by the trusted document's applier on ops relayed from the L2 Worker (default
   * spec-core's DEFAULT_MAX_DOM_NODES / DEFAULT_MAX_DOM_DEPTH / DEFAULT_MUTATIONS_PER_MINUTE). `maxDomNodes`
   * bounds the number of nodes **currently connected** to the document, counted per subtree as nodes are
   * attached and detached — not the lifetime count of nodes ever created — so removing nodes frees budget for
   * new ones (see dom-applier.ts's module docstring for the live-node accounting and its own lifetime-record
   * memory cap). See resolvePolicy's docstring: buildSrcdoc's frozen signature currently ignores an override
   * here and always builds with the defaults — resolved for forward compatibility, not yet load-bearing.
   */
  maxDomNodes?: number;
  maxDomDepth?: number;
  mutationsPerMinute?: number;
}

export interface ResolvedSandboxPolicy {
  csp: string;
  bootTimeoutMs: number;
  rpcTimeoutMs: number;
  fetchesPerMinute: number;
  maxConcurrentFetches: number;
  maxPayloadBytes: number;
  maxHtmlBytes: number;
  maxHeightPx: number;
  eventsPerMinute: number;
  telemetryPerMinute: number;
  resizesPerMinute: number;
  maxEventPayloadBytes: number;
  maxDomNodes: number;
  maxDomDepth: number;
  mutationsPerMinute: number;
}

export type SandboxState = "loading" | "ready" | "error" | "destroyed";

export interface SandboxHandle {
  updateProps(props: JsonObject): void;
  invalidate(ref: string): void;
  destroy(): void;
  readonly state: SandboxState;
  /** Subscribes to state transitions (SandboxFrame uses this for UI display) */
  onStateChange(listener: (state: SandboxState, detail?: string) => void): void;
}

/**
 * A design-kit stylesheet carrying version identity, letting the sandbox detect a mismatch against
 * `Spec.provenance.kit` (see `MountSandboxOptions.kit` / `provenanceKit`) instead of only injecting CSS
 * blind. `id`/`version` are presentational metadata only — they play no role in which selectors the CSS
 * defines; the mismatch check compares them against `provenanceKit` purely to warn, never to alter what
 * gets injected.
 */
export interface DesignKitStylesheet {
  id: string;
  version: string;
  css: string;
}

export interface MountSandboxOptions {
  container: HTMLElement;
  componentId: string;
  artifact: SandboxArtifact;
  /** The single $ref this node is allowed to reference (only an exact match is resolved) */
  allowedRef?: string;
  /** Event names declared in the Spec's events (anything else is dropped) */
  allowedEvents: string[];
  initialProps?: JsonObject;
  bridge: SandboxBridge;
  policy?: SandboxPolicy;
  /**
   * Design tokens. Injected into the srcdoc's <head> as `:root { --kohaku-*: … }`, they resolve the generated HTML's
   * token references var(--kohaku-*) (the realization of keeping values out of the sha256-hashed artifact so it stays
   * theme-independent — the environment-neutrality principle, SPEC-ENV-003).
   * Even when unspecified, the default light theme is always injected (renderer-core's sandboxThemeCss handles the merge).
   * On theme switch a re-mount (rebuilding the srcdoc) is required — SandboxFrame / renderer-wc include it as a dependency.
   */
  theme?: ThemeTokens;
  /**
   * The design-kit stylesheet injected into the srcdoc after the theme variables and before the generated
   * CSS (so generated styles can override it). `undefined` injects renderer-core's `defaultDesignKit.css`;
   * `""` injects nothing; a bare string is the product's own kit with no version identity (trusted CSS —
   * escaped against `</style>` breakout but not otherwise sanitized; never checked against
   * `provenanceKit`, the same behavior as the deprecated `kitCss` below); a `DesignKitStylesheet`
   * additionally carries `id`/`version`, compared against `provenanceKit` (a mismatch is reported via
   * `bridge.onTelemetry({kind: "kit-mismatch"})` but never blocks rendering — fail-open, SPEC-KIT-001).
   * Supersedes `kitCss` when both are given. Pairs with composer's `DesignSystemGuide.kit`.
   */
  kit?: DesignKitStylesheet | string;
  /**
   * The design kit identity the generated markup was actually written against (`Spec.provenance.kit`, when
   * the composer recorded one — see `ProvenanceSchema.kit`). Used only to detect a version mismatch
   * against `kit` above when `kit` is a `DesignKitStylesheet`; passing this without `kit` carrying its own
   * `id`/`version` performs no comparison (there is nothing to compare against).
   */
  provenanceKit?: { id: string; version: string };
  /**
   * @deprecated Use `kit` instead (a bare string passed to `kit` is equivalent). Ignored whenever `kit` is
   * set. Kept only for backward compatibility with callers that predate `kit`.
   */
  kitCss?: string;
}
