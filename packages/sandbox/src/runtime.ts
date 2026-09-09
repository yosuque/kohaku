/**
 * Builds the trusted iframe document's own inline runtime script — what buildSrcdoc places inside the
 * `<script nonce>` tag. This replaces the old same-document click-guard-only runtime: generated L2 code now
 * runs in a Worker with no `document` of its own (SBX-EXEC-001 / docs/design.md §8), and `domApplierMain`
 * (packages/sandbox/src/guest/dom-applier.ts) is the document-side counterpart that boots that Worker, relays
 * its ops through the allowlist, and speaks the unchanged parent-facing bridge protocol (protocol.ts /
 * host-bridge.ts needed no changes for this).
 */
import {
  ALLOWED_ATTR_PREFIXES,
  ALLOWED_ATTRS,
  ALLOWED_PROPERTY_OPS,
  ALLOWED_STYLE_PROPS,
  ALLOWED_TAGS,
  ALWAYS_DENIED_ATTRS,
} from "@kohaku-ui/spec-core";
import { type DomApplierAllowlist, domApplierMain } from "./guest/dom-applier.js";
import { buildWorkerShimJs, NAME_HELPER_SHIM } from "./guest/worker-shim.js";

export interface RuntimeJsConfig {
  nonce: string;
  rpcTimeoutMs: number;
  maxDomNodes: number;
  maxDomDepth: number;
  mutationsPerMinute: number;
  /** The generated artifact's original `<body>` markup (splitArtifact's `body`). */
  bodyHtml: string;
  /** The generated artifact's `<script>` bodies, already concatenated in document order. */
  scripts: string;
}

/** The DOM allowlist data, gathered once from spec-core and reused across mounts (the source of truth is packages/spec-core/src/schema/sandbox-dom.ts). */
const ALLOWLIST: DomApplierAllowlist = {
  tags: [...ALLOWED_TAGS],
  attrs: [...ALLOWED_ATTRS],
  attrPrefixes: [...ALLOWED_ATTR_PREFIXES],
  alwaysDeniedAttrs: [...ALWAYS_DENIED_ATTRS],
  styleProps: [...ALLOWED_STYLE_PROPS],
  propertyOps: [...ALLOWED_PROPERTY_OPS],
};

/** Best-effort default viewport width baked into the Worker's boot config; domApplierMain corrects it live once the iframe exists (see worker-shim.ts's module docstring). */
const DEFAULT_VIEWPORT_WIDTH = 800;

export function buildRuntimeJs(config: RuntimeJsConfig): string {
  const workerShimJs = buildWorkerShimJs({
    rpcTimeoutMs: config.rpcTimeoutMs,
    viewportWidth: DEFAULT_VIEWPORT_WIDTH,
    bodyHtml: config.bodyHtml,
  });
  const applierConfig = {
    nonce: config.nonce,
    maxDomNodes: config.maxDomNodes,
    maxDomDepth: config.maxDomDepth,
    mutationsPerMinute: config.mutationsPerMinute,
    workerShimJs,
    scripts: config.scripts,
    allowlist: ALLOWLIST,
  };
  // Every `<` in a JSON.stringify() result is necessarily inside a quoted string value (JSON's own syntax
  // outside strings never contains "<"), so this blind replace is always safe and is what prevents a
  // generated artifact's script/body content from breaking out of the enclosing <script> via "</script>" or
  // "<!--" — the standard technique for embedding untrusted JSON inside an inline script.
  const configJson = JSON.stringify(applierConfig).replace(/</g, "\\u003c");
  return `${NAME_HELPER_SHIM}(${domApplierMain.toString()})(${configJson});`;
}
