/**
 * A component artifact's html body found in the lineage log or a promotion snapshot, alongside the
 * hash the source itself claimed for it (if any). Shared by build.ts (assembling the pack) and
 * sign.ts (`verifyEvidencePack`'s independent re-scan), so the two never drift on what counts as "an
 * artifact reference" or where its html can be found.
 */
export interface ArtifactClaim {
  artifactId: string;
  html: string;
  claimedSha256?: string;
}

/** Extracts an ArtifactClaim from a `component.generated` lineage event's payload, if it carries html
 * (see @kohaku-ui/lineage's `ComponentGeneratedPayload`). */
export function artifactClaimFromEventPayload(
  type: string,
  payload: Record<string, unknown>,
): ArtifactClaim | undefined {
  if (type !== "component.generated") return undefined;
  const { artifactId, html, artifactSha256 } = payload;
  if (typeof artifactId !== "string" || typeof html !== "string" || html.length === 0) return undefined;
  return {
    artifactId,
    html,
    ...(typeof artifactSha256 === "string" ? { claimedSha256: artifactSha256 } : {}),
  };
}

/**
 * Extracts an ArtifactClaim from a PromotionState's `data`, if it carries html -- populated once a
 * candidate is published (see packages/lineage/src/promotion/candidate-store.ts's "self-contained
 * published projection", which duplicates `html`/`sha256` onto `data` at that point).
 */
export function artifactClaimFromPromotionData(
  artifactId: string,
  data: Record<string, unknown>,
): ArtifactClaim | undefined {
  const { html, sha256 } = data;
  if (typeof html !== "string" || html.length === 0) return undefined;
  return { artifactId, html, ...(typeof sha256 === "string" ? { claimedSha256: sha256 } : {}) };
}
