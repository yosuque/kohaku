import { describe, expect, it } from "vitest";
import {
  EVIDENCE_PACK_FORMAT,
  EVIDENCE_PACK_VERSION,
  EvidenceManifestSchema,
  isSafeEvidenceFilePath,
} from "../../src/evidence/manifest.js";

function validManifest() {
  return {
    format: EVIDENCE_PACK_FORMAT,
    version: EVIDENCE_PACK_VERSION,
    generator: "kohaku-cli/0.3.0",
    generatedAt: "2026-02-01T00:00:00.000Z",
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

  it("requires warnings (no silent default for a required field)", () => {
    const { warnings, ...rest } = validManifest();
    expect(() => EvidenceManifestSchema.parse(rest)).toThrow();
  });

  it("rejects an unknown top-level key", () => {
    expect(() =>
      EvidenceManifestSchema.parse({ ...validManifest(), injected: "approved by legal" }),
    ).toThrow();
  });

  it("rejects an unknown key inside a nested object", () => {
    const manifest = validManifest();
    expect(() =>
      EvidenceManifestSchema.parse({ ...manifest, scope: { ...manifest.scope, extra: 1 } }),
    ).toThrow();
    expect(() =>
      EvidenceManifestSchema.parse({ ...manifest, signer: { ...manifest.signer, note: "x" } }),
    ).toThrow();
    expect(() =>
      EvidenceManifestSchema.parse({ ...manifest, files: [{ ...manifest.files[0]!, extra: true }] }),
    ).toThrow();
  });

  it("rejects a string where a number is required (no coercion)", () => {
    const manifest = validManifest();
    expect(() =>
      EvidenceManifestSchema.parse({ ...manifest, files: [{ ...manifest.files[0]!, bytes: "10" }] }),
    ).toThrow();
  });

  it("rejects an unknown format literal", () => {
    expect(() => EvidenceManifestSchema.parse({ ...validManifest(), format: "other" })).toThrow();
  });

  it("rejects a malformed sha256", () => {
    const manifest = validManifest();
    manifest.files[0]!.sha256 = "not-a-hash";
    expect(() => EvidenceManifestSchema.parse(manifest)).toThrow();
  });

  // Same trailing-newline regression lock as files[].path above: JS's `$` never matched here, but this
  // pins the behavior now that Python's mirror needed fullmatch to reject the equivalent case.
  it("rejects a sha256 with a trailing newline", () => {
    const manifest = validManifest();
    manifest.files[0]!.sha256 = `${"a".repeat(64)}\n`;
    expect(() => EvidenceManifestSchema.parse(manifest)).toThrow();
  });

  it("rejects a malformed keyId", () => {
    const manifest = validManifest();
    manifest.signer.keyId = "too-short";
    expect(() => EvidenceManifestSchema.parse(manifest)).toThrow();
  });

  it("rejects a keyId with a trailing newline", () => {
    const manifest = validManifest();
    manifest.signer.keyId = "0123456789abcdef\n";
    expect(() => EvidenceManifestSchema.parse(manifest)).toThrow();
  });

  // A files[].path ultimately drives a filesystem read (verifyEvidencePack / the CLI's directory
  // reader) over data from a manifest a verifier does not yet trust -- the schema is the first line of
  // defense against path traversal / an absolute path / an arbitrary filename.
  it.each([
    "../../../etc/passwd",
    "/etc/passwd",
    "artifacts/../../../etc/passwd",
    "artifacts\\..\\..\\etc\\passwd",
    "events.jsonl/../../../etc/passwd",
    "",
    "events.json", // close to a real name, but not one of the four exact filenames
    "artifacts/not-a-hash.html",
    `artifacts/${"a".repeat(63)}.html`, // one hex character short
    `artifacts/${"a".repeat(65)}.html`, // one hex character too many
    `artifacts/${"A".repeat(64)}.html`, // uppercase hex
    "artifacts/subdir/aaaa.html",
    // A trailing newline: JS's `$` (no `m` flag) anchors strictly to the end of the string, unlike
    // Python's `$`, which also matches immediately before a trailing "\n" -- this case locks in that TS
    // was never vulnerable to the mismatch Python's is_safe_evidence_file_path had to fix (fullmatch).
    "events.jsonl\n",
    `artifacts/${"a".repeat(64)}.html\n`,
  ])("rejects an unsafe files[].path %s", (path) => {
    const manifest = validManifest();
    manifest.files[0]!.path = path;
    expect(() => EvidenceManifestSchema.parse(manifest)).toThrow();
    expect(isSafeEvidenceFilePath(path)).toBe(false);
  });

  it.each([
    "events.jsonl",
    "approvals.jsonl",
    "promotions.jsonl",
    "fixations.jsonl",
    `artifacts/${"a".repeat(64)}.html`,
  ])("accepts the safe files[].path %s", (path) => {
    expect(isSafeEvidenceFilePath(path)).toBe(true);
  });
});
