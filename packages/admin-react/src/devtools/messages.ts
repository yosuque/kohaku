/**
 * Typed dictionary for every string KohakuDevTools renders. Same "EN default, injectable" convention as
 * `AdminMessages` (../messages.ts), but a separate type: DevTools lives on its own subpath, decoupled from
 * AdminProvider/KohakuAdmin, so a product embedding it standalone should not need to also pull in the full
 * admin console's message dictionary.
 */
export interface DevToolsMessages {
  title: string;
  requestIdLabel: string;
  explainButton: string;
  loading: string;
  /** Shown when the explain report came back with zero view.composed events for the given requestId. */
  notFound: string;
  fetchFailed: (message: string) => string;
  recentRequestsLabel: string;
  panels: {
    specTree: string;
    provenance: string;
    cacheKey: string;
    decision: string;
    scopes: string;
    lineage: string;
  };
  provenance: {
    tierCacheLabel: string;
    modelLabel: string;
    generatorVersionLabel: string;
    designKitLabel: string;
    fallbackLabel: (kind: string) => string;
    empty: string;
  };
  cacheKey: {
    keyLabel: string;
    specVersionLabel: string;
    intentHashLabel: string;
    dataVersionLabel: string;
    catalogFingerprintLabel: string;
    generatorVersionLabel: string;
    policyFingerprintLabel: string;
    empty: string;
  };
  decision: {
    attemptOk: string;
    attemptFailed: string;
    downgradeLabel: (id: string, from: string, to: string) => string;
    coalescedLabel: string;
    usageLabel: (input: number, output: number) => string;
    empty: string;
  };
  scopes: {
    empty: string;
    /** Shown instead of `empty` when no Spec was passed at all (distinct from "the Spec declares no scopes"). */
    noSpec: string;
  };
  lineage: {
    empty: string;
    payloadSummary: string;
  };
  specTree: {
    empty: string;
  };
  /** A composes-array entry header, shown only when more than one compose shares the requestId (a reused id). */
  composeIndex: (index: number, total: number) => string;
}

export const defaultDevToolsMessages: DevToolsMessages = {
  title: "Kohaku DevTools",
  requestIdLabel: "Request ID",
  explainButton: "Explain",
  loading: "Loading…",
  notFound: "No view.composed event found for this request ID.",
  fetchFailed: (message) => `Failed to fetch the explain report: ${message}`,
  recentRequestsLabel: "Recent requests",
  panels: {
    specTree: "Spec",
    provenance: "Provenance",
    cacheKey: "Cache key",
    decision: "Decision",
    scopes: "Scopes",
    lineage: "Lineage",
  },
  provenance: {
    tierCacheLabel: "Tier / cache",
    modelLabel: "Model",
    generatorVersionLabel: "Generator version",
    designKitLabel: "Design kit",
    fallbackLabel: (kind) => `Fallback (${kind})`,
    empty: "No compose found for this request ID.",
  },
  cacheKey: {
    keyLabel: "Cache key",
    specVersionLabel: "specVersion",
    intentHashLabel: "intentHash",
    dataVersionLabel: "dataVersion",
    catalogFingerprintLabel: "catalogFingerprint",
    generatorVersionLabel: "generatorVersion",
    policyFingerprintLabel: "policyFingerprint",
    empty:
      "No cache key recorded for this compose (recorded before correlationId support shipped, or an L0 fixation).",
  },
  decision: {
    attemptOk: "ok",
    attemptFailed: "failed",
    downgradeLabel: (id, from, to) => `downgrade: ${id} ${from} → ${to}`,
    coalescedLabel: "Rode along on another compose under single-flight",
    usageLabel: (input, output) => `${input} input / ${output} output tokens`,
    empty: "No decision data recorded (a cache hit or L0 fixed Spec has nothing to decide).",
  },
  scopes: {
    empty: "The Spec declares no capability scopes.",
    noSpec: "Pass a Spec to see its capability scopes.",
  },
  lineage: {
    empty: "No lineage events found for this request ID.",
    payloadSummary: "payload",
  },
  specTree: {
    empty: "Pass a Spec to see its component tree.",
  },
  composeIndex: (index, total) => `Compose ${index} of ${total} (a reused request ID)`,
};
