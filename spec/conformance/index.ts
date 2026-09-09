import { REQUIREMENTS, type Requirement } from "./manifest.js";
import { runRestSuite } from "./rest-host.js";
import { runSpecFormatSuite } from "./spec-format.js";
import type { ConformanceReport, ConformanceResult, RestTarget } from "./types.js";

export type { ConformanceReport, ConformanceResult, Requirement, RestTarget };
export { REQUIREMENTS, runRestSuite, runSpecFormatSuite };

/** Reconciles results against the requirements table (MUST/SHOULD) into a report. */
export function buildReport(results: ConformanceResult[]): ConformanceReport {
  const byId = new Map(REQUIREMENTS.map((r) => [r.id, r]));
  // A result flagged notChecked (e.g. LIN-PRM-001 when GET /lineage itself is unreachable) is treated as if
  // the check had not been attempted at all: excluded here from countedResults, its id falls out of
  // checkedIds below and flows through the same uncheckedMusts -> notCheckedMustIds path as a MUST this suite
  // never ran, rather than counting as a pass (masking an unreachable dependency) or a fail (blocking
  // CONFORMANT on an optional black-box precondition).
  const countedResults = results.filter((r) => r.notChecked !== true);
  const musts = countedResults.filter((r) => byId.get(r.id)?.level === "MUST");
  const mustPassed = musts.filter((r) => r.pass).length;
  // Split the MUSTs that did not appear in the counted results into two by verification category:
  // - reference: guaranteed by reference-implementation tests (verifiedBy) = not unchecked (referenceVerifiedIds).
  // - blackbox: not checked by this suite = unchecked, tracked to prevent a false-positive CONFORMANT (notCheckedMustIds).
  const checkedIds = new Set(countedResults.map((r) => r.id));
  const uncheckedMusts = REQUIREMENTS.filter((r) => r.level === "MUST" && !checkedIds.has(r.id));
  const notCheckedMustIds = uncheckedMusts.filter((r) => r.verification === "blackbox").map((r) => r.id);
  const referenceVerifiedIds = uncheckedMusts.filter((r) => r.verification === "reference").map((r) => r.id);
  return {
    results,
    mustTotal: musts.length,
    mustPassed,
    pass: mustPassed === musts.length,
    notCheckedMustIds,
    referenceVerifiedIds,
  };
}

export function formatReport(report: ConformanceReport): string {
  const byId = new Map(REQUIREMENTS.map((r) => [r.id, r]));
  // A notChecked result (e.g. LIN-PRM-001 when GET /lineage itself is unreachable) is reported once, below,
  // via the ▢ not-checked list — not here as a ✗ (it was never actually attempted, so a fail mark would be
  // misleading; buildReport already excludes it from mustTotal/mustPassed).
  const lines = report.results
    .filter((r) => r.notChecked !== true)
    .map((r) => {
      const req = byId.get(r.id);
      const mark = r.pass ? (r.skipped ? "○ (skip)" : "✓") : "✗";
      const level = req?.level ?? "?";
      return `${mark} [${level}] ${r.id} ${req?.description ?? ""}${r.detail != null ? ` — ${r.detail}` : ""}`;
    });
  // Surface the MUSTs guaranteed by reference-implementation tests (outside the black-box check). Distinguished because they are not "unchecked".
  for (const id of report.referenceVerifiedIds) {
    const req = byId.get(id);
    lines.push(
      `◇ [MUST] ${id} ${req?.description ?? ""} — guaranteed by reference-implementation tests (outside black-box check${
        req?.verifiedBy != null ? `: ${req.verifiedBy}` : ""
      })`,
    );
  }
  // Surface the unchecked MUSTs: either genuinely outside this suite's scope (other profiles), or flagged
  // notChecked because the check itself could not be attempted this run (its specific reason, when known,
  // replaces the generic "not checked" text). Without this, seeing only "7/7 → CONFORMANT" could be misread
  // as the REST MUSTs (or this run's unreachable dependency) having passed too.
  const notCheckedDetails = new Map(
    report.results.filter((r) => r.notChecked === true).map((r) => [r.id, r.detail] as const),
  );
  for (const id of report.notCheckedMustIds) {
    const req = byId.get(id);
    const detail = notCheckedDetails.get(id) ?? "not checked (outside this suite)";
    lines.push(`▢ [MUST] ${id} ${req?.description ?? ""} — ${detail}`);
  }
  lines.push("");
  const verdict = !report.pass
    ? "NOT CONFORMANT"
    : report.notCheckedMustIds.length > 0
      ? `CONFORMANT (${report.notCheckedMustIds.length} MUST not checked)`
      : "CONFORMANT";
  lines.push(`MUST: ${report.mustPassed}/${report.mustTotal} passed → ${verdict}`);
  return lines.join("\n");
}
