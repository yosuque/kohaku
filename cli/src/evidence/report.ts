import type { VerifyEvidencePackResult } from "@kohaku-ui/lineage";
import type { EvidenceExportResult } from "./export.js";
import type { EvidenceKeygenResult } from "./keygen.js";

/**
 * The text `kohaku evidence keygen` prints, as one string with its newlines (the caller does a single
 * `console.log`, which adds the final one).
 */
export function formatEvidenceKeygenResult(result: EvidenceKeygenResult): string {
  return [
    `Generated ${result.privateKeyPath} (mode 0600)`,
    `Generated ${result.publicKeyPath}`,
    `keyId: ${result.keyId}`,
  ].join("\n");
}

/** The text `kohaku evidence export` prints: the pack location, its counts, and any manifest warnings. */
export function formatEvidenceExportResult(result: EvidenceExportResult): string {
  const c = result.manifest.counts;
  const lines = [
    `Wrote evidence pack to ${result.outDir}`,
    `  events=${c.events} approvals=${c.approvals} promotions=${c.promotions} fixations=${c.fixations} artifacts=${c.artifacts}` +
      (result.manifest.complete ? "" : " (incomplete)"),
  ];
  if (result.manifest.warnings.length > 0) {
    lines.push("  warnings:");
    for (const w of result.manifest.warnings) lines.push(`    - ${w}`);
  }
  return lines.join("\n");
}

/**
 * The text `kohaku evidence verify` prints on stdout: the verdict, the fatal errors of an invalid pack, and the
 * non-fatal artifact mismatches. The exit code (0 valid / 1 invalid) stays with the caller.
 */
export function formatEvidenceVerifyResult(result: VerifyEvidencePackResult): string {
  const lines: string[] = [];
  if (result.ok) {
    lines.push("OK: the evidence pack is valid.");
  } else {
    lines.push("INVALID:");
    for (const err of result.errors) lines.push(`  - ${err}`);
  }
  if (result.mismatches.length > 0) {
    lines.push("Non-fatal artifact mismatches:");
    for (const m of result.mismatches) lines.push(`  - ${m}`);
  }
  return lines.join("\n");
}
