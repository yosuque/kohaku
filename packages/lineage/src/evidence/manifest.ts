import { z } from "zod";

/**
 * Compliance Evidence Pack manifest (design.md #67). A pack is a directory of normalized,
 * append-only exports (lineage events, an approvals index, promotion/fixation snapshots, and the
 * referenced component artifacts) plus this manifest and a detached Ed25519 signature
 * (`manifest.sig`, see sign.ts). This schema lives here, in @kohaku-ui/lineage, and is
 * **deliberately not exposed under spec/schemas** -- it describes an export format for auditors,
 * not a wire type the Kohaku Protocol negotiates between a host and a renderer.
 */
export const EVIDENCE_PACK_FORMAT = "kohaku-evidence-pack";
export const EVIDENCE_PACK_VERSION = 1;

/**
 * The only shapes `manifest.files[].path` may take: one of the four fixed jsonl filenames, or an
 * artifact keyed by its own sha256. Deliberately closed (no wildcard subdirectories, no `..`, no
 * absolute path, no backslash) because this string ultimately drives a filesystem read
 * (`verifyEvidencePack` / the CLI's directory reader) over data from a manifest a verifier is, by
 * definition, not yet sure it can trust -- path traversal / an absolute path must be rejected at parse
 * time, not left to whatever the reader happens to do with it.
 */
export const EVIDENCE_FILE_PATH_PATTERN =
  /^(?:events|approvals|promotions|fixations)\.jsonl$|^artifacts\/[0-9a-f]{64}\.html$/;

/** Structural re-check of `EVIDENCE_FILE_PATH_PATTERN`, for a caller (e.g. `verifyEvidencePack`) that
 * wants to defend against a `path` reaching it some other way than through this schema. */
export function isSafeEvidenceFilePath(path: string): boolean {
  return EVIDENCE_FILE_PATH_PATTERN.test(path);
}

/** One file inside the pack, as recorded for integrity verification. */
export const EvidenceFileEntrySchema = z.object({
  /** Path relative to the pack directory: "events.jsonl" / "approvals.jsonl" / "promotions.jsonl" /
   * "fixations.jsonl" / "artifacts/<sha256>.html" -- see `EVIDENCE_FILE_PATH_PATTERN`. */
  path: z
    .string()
    .regex(EVIDENCE_FILE_PATH_PATTERN, "must be a fixed jsonl filename or artifacts/<sha256>.html"),
  /** sha256 of the file's exact on-disk bytes (hex, lowercase). */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
  /** Line count for a *.jsonl file. Omitted for a non-JSONL file (e.g. an artifact HTML file). */
  records: z.number().int().nonnegative().optional(),
});
export type EvidenceFileEntry = z.infer<typeof EvidenceFileEntrySchema>;

/** The export's scope: a time window (mandatory) and an optional tenant restriction. */
export const EvidenceManifestScopeSchema = z.object({
  tenant: z.string().optional(),
  /** Inclusive lower bound of the exported lineage window (canonical ISO 8601). */
  since: z.string(),
  /** Inclusive upper bound of the exported lineage window (canonical ISO 8601). */
  until: z.string(),
});
export type EvidenceManifestScope = z.infer<typeof EvidenceManifestScopeSchema>;

/** Record counts per exported file, for an auditor's at-a-glance summary (see files[] for integrity). */
export const EvidenceManifestCountsSchema = z.object({
  events: z.number().int().nonnegative(),
  approvals: z.number().int().nonnegative(),
  promotions: z.number().int().nonnegative(),
  fixations: z.number().int().nonnegative(),
  artifacts: z.number().int().nonnegative(),
});
export type EvidenceManifestCounts = z.infer<typeof EvidenceManifestCountsSchema>;

export const EvidenceManifestSignerSchema = z.object({
  alg: z.literal("Ed25519"),
  /** First 16 hex characters of sha256(rawPublicKeyBytes) -- enough to pick the right key, not a full fingerprint. */
  keyId: z.string().regex(/^[0-9a-f]{16}$/),
});
export type EvidenceManifestSigner = z.infer<typeof EvidenceManifestSignerSchema>;

export const EvidenceManifestSchema = z.object({
  format: z.literal(EVIDENCE_PACK_FORMAT),
  version: z.literal(EVIDENCE_PACK_VERSION),
  /** Identity of whatever produced this pack (e.g. "kohaku-cli/0.3.0"). Free-form, not parsed. */
  generator: z.string().min(1),
  /** When the export itself ran (canonical ISO 8601; clock-injected -- see build.ts's `now` option),
   * distinct from `scope.since`/`scope.until`, which bound the exported data, not the export moment. */
  generatedAt: z.string(),
  scope: EvidenceManifestScopeSchema,
  counts: EvidenceManifestCountsSchema,
  /**
   * False when the export is known not to be exhaustive over `scope`, for any reason -- not only that
   * the StoragePort backing the source has no `pageLineage` and the caller passed `allowIncomplete` to
   * fall back to a bounded tail window instead of failing outright (`buildEvidencePack`'s own concern),
   * but also a structural limitation of the source itself, e.g. a REST-sourced export whose
   * `fixations.jsonl` is left empty because `GET /fixations` cannot supply a full `FixationRecord` (the
   * CLI sets this alongside the corresponding `warnings` entry in that case). An auditor MUST treat an
   * incomplete pack as a partial record, not as proof of the absence of events/records outside what it
   * contains.
   */
  complete: z.boolean(),
  files: z.array(EvidenceFileEntrySchema),
  /**
   * Non-fatal integrity notes gathered while building the pack (e.g. a component artifact whose
   * recorded `artifactSha256` did not match sha256 of its own recorded html) -- the export is not
   * aborted by these, they are surfaced here for the auditor to follow up on instead.
   */
  warnings: z.array(z.string()).default([]),
  signer: EvidenceManifestSignerSchema,
});
export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;
