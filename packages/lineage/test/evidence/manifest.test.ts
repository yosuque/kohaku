import { describe, expect, it } from "vitest";
import {
  EVIDENCE_PACK_FORMAT,
  EVIDENCE_PACK_VERSION,
  EvidenceManifestSchema,
} from "../../src/evidence/manifest.js";

function validManifest() {
  return {
    format: EVIDENCE_PACK_FORMAT,
    version: EVIDENCE_PACK_VERSION,
    generator: "kohaku-cli/0.3.0",
    scope: { since: "2026-01-01T00:00:00.000Z", until: "2026-01-31T23:59:59.999Z" },
    counts: { events: 1, approvals: 0, promotions: 0, fixations: 0, artifacts: 0 },
    complete: true,
    files: [
      {
        path: "events.jsonl",
        sha256: "a".repeat(64),
        bytes: 10,
        records: 1,
      },
    ],
    warnings: [],
    signer: { alg: "Ed25519" as const, keyId: "0123456789abcdef" },
  };
}

describe("EvidenceManifestSchema", () => {
  it("accepts a well-formed manifest", () => {
    const result = EvidenceManifestSchema.parse(validManifest());
    expect(result.format).toBe("kohaku-evidence-pack");
    expect(result.version).toBe(1);
  });

  it("defaults warnings to an empty array when omitted", () => {
    const { warnings, ...rest } = validManifest();
    const result = EvidenceManifestSchema.parse(rest);
    expect(result.warnings).toEqual([]);
  });

  it("rejects an unknown format literal", () => {
    expect(() => EvidenceManifestSchema.parse({ ...validManifest(), format: "other" })).toThrow();
  });

  it("rejects a malformed sha256", () => {
    const manifest = validManifest();
    manifest.files[0]!.sha256 = "not-a-hash";
    expect(() => EvidenceManifestSchema.parse(manifest)).toThrow();
  });

  it("rejects a malformed keyId", () => {
    const manifest = validManifest();
    manifest.signer.keyId = "too-short";
    expect(() => EvidenceManifestSchema.parse(manifest)).toThrow();
  });
});
