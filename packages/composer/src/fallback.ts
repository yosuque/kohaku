import { type CanonicalIntent, canonicalStringify, SPEC_VERSION, type UISpec } from "@kohaku-ui/spec-core";

/**
 * Deterministic fallback Spec used when L1 is exhausted and L2 is not permitted either.
 * Uses no LLM at all, showing a summary of the Intent with presentMarkdown only.
 */
export function buildFallbackSpec(args: {
  intent: CanonicalIntent;
  dataVersion: string;
  reason: string;
  composedBy: string;
  /** Observation label per cacheMode (do not mislabel a fallback under bypass as miss) */
  cache?: UISpec["provenance"]["cache"];
  /**
   * The tier that actually failed. Reflected in both provenance.tier and fallback.from.
   * When L2 fails via routeTier=L2 direct entry or an L1→L2 promotion, passing "L2" prevents
   * mislabeling (which would otherwise always be "L1").
   * Unspecified defaults to "L1" (backward compatible).
   */
  from?: "L1" | "L2";
}): UISpec {
  const from = args.from ?? "L1";
  return {
    kohaku: SPEC_VERSION,
    intent: args.intent,
    dataVersion: args.dataVersion,
    components: [
      {
        id: "root",
        type: "layout.stack",
        props: { direction: "vertical", gap: "md" },
        children: ["md1"],
      },
      {
        id: "md1",
        type: "presentMarkdown",
        props: {
          markdown: [
            "### Could not render this request",
            "",
            `Requested intent: \`${args.intent.canonical}\``,
            "",
            "```json",
            canonicalStringify(args.intent.params),
            "```",
            "",
            `Reason: ${args.reason}`,
          ].join("\n"),
        },
      },
    ],
    events: [],
    provenance: {
      tier: from,
      composedBy: args.composedBy,
      cache: args.cache ?? "miss",
      fallback: { from, reason: args.reason, kind: "generation" },
    },
  };
}
