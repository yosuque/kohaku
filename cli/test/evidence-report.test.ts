import type { VerifyEvidencePackResult } from "@kohaku-ui/lineage";
import { describe, expect, it } from "vitest";
import {
  formatEvidenceExportResult,
  formatEvidenceKeygenResult,
  formatEvidenceVerifyResult,
} from "../src/evidence/report.js";

type ExportResult = Parameters<typeof formatEvidenceExportResult>[0];

function exportResult(manifest: { complete: boolean; warnings: string[] }): ExportResult {
  return {
    outDir: "/packs/q3",
    manifest: {
      ...manifest,
      counts: { events: 12, approvals: 3, promotions: 2, fixations: 5, artifacts: 7 },
    } as ExportResult["manifest"],
  };
}

describe("formatEvidenceKeygenResult", () => {
  it("lists both key files and the key id", () => {
    expect(
      formatEvidenceKeygenResult({
        privateKeyPath: "/keys/evidence.key.pem",
        publicKeyPath: "/keys/evidence.pub.pem",
        keyId: "ed25519:abc",
      }),
    ).toBe(
      "Generated /keys/evidence.key.pem (mode 0600)\nGenerated /keys/evidence.pub.pem\nkeyId: ed25519:abc",
    );
  });
});

describe("formatEvidenceExportResult", () => {
  it("prints the counts of a complete pack without warnings", () => {
    expect(formatEvidenceExportResult(exportResult({ complete: true, warnings: [] }))).toBe(
      "Wrote evidence pack to /packs/q3\n" + "  events=12 approvals=3 promotions=2 fixations=5 artifacts=7",
    );
  });

  it("marks an incomplete pack and lists its warnings", () => {
    expect(formatEvidenceExportResult(exportResult({ complete: false, warnings: ["w1", "w2"] }))).toBe(
      "Wrote evidence pack to /packs/q3\n" +
        "  events=12 approvals=3 promotions=2 fixations=5 artifacts=7 (incomplete)\n" +
        "  warnings:\n" +
        "    - w1\n" +
        "    - w2",
    );
  });
});

describe("formatEvidenceVerifyResult", () => {
  const base = { ok: true, errors: [], mismatches: [] } as VerifyEvidencePackResult;

  it("prints the single OK line for a valid pack", () => {
    expect(formatEvidenceVerifyResult(base)).toBe("OK: the evidence pack is valid.");
  });

  it("lists every fatal error of an invalid pack", () => {
    expect(formatEvidenceVerifyResult({ ...base, ok: false, errors: ["e1", "e2"] })).toBe(
      "INVALID:\n  - e1\n  - e2",
    );
  });

  it("appends non-fatal mismatches after the verdict", () => {
    expect(formatEvidenceVerifyResult({ ...base, mismatches: ["m1"] })).toBe(
      "OK: the evidence pack is valid.\nNon-fatal artifact mismatches:\n  - m1",
    );
    expect(formatEvidenceVerifyResult({ ...base, ok: false, errors: ["e1"], mismatches: ["m1", "m2"] })).toBe(
      "INVALID:\n  - e1\nNon-fatal artifact mismatches:\n  - m1\n  - m2",
    );
  });
});
