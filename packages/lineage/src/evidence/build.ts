import {
  canonicalStringify,
  type LineageEventRecord,
  MAX_LINEAGE_PAGE_SIZE,
  type PromotionState,
  sha256Hex,
} from "@kohaku-ui/spec-core";
import {
  EVIDENCE_PACK_FORMAT,
  EVIDENCE_PACK_VERSION,
  type EvidenceFileEntry,
  type EvidenceManifest,
  type EvidenceManifestSigner,
} from "./manifest.js";
import type { EvidenceSource } from "./source.js";

/**
 * Lineage event types folded into `approvals.jsonl` -- the human/governance decision points in the
 * lineage log. This is a filtered *index* into `events.jsonl`, not a separate record shape: each line
 * is the same normalized `LineageEventRecord` as the full log.
 *
 * Note: `intent.migrated` does not exist as a lineage event type in this codebase (see
 * `@kohaku-ui/lineage`'s `LineageEventType` -- the fixation family is only `intent.observed`
 * (reserved, never fired) / `intent.fixated` / `intent.unfixated`), so it is not included here. If a
 * future change introduces it, add it to this list.
 */
export const EVIDENCE_APPROVAL_EVENT_TYPES: readonly string[] = [
  "component.reviewed",
  "component.published",
  "component.withdrawn",
  "intent.fixated",
  "intent.unfixated",
];

export interface EvidencePackScope {
  tenant?: string;
  /** Inclusive lower bound of the exported lineage window (canonical ISO 8601). */
  since: string;
  /** Inclusive upper bound of the exported lineage window (canonical ISO 8601). */
  until: string;
}

export interface BuildEvidencePackOptions {
  source: EvidenceSource;
  scope: EvidencePackScope;
  /** Identity recorded on the manifest as `generator` (e.g. "kohaku-cli/0.3.0"). */
  generator: string;
  /**
   * The signer identity to record on the manifest (`alg` + `keyId`). Computed by the caller from the
   * public key it will sign with (see sign.ts's `deriveEd25519KeyId`) -- `buildEvidencePack` itself
   * never touches key material, so the assembly step stays independent of signing (sign.ts).
   */
  signer: EvidenceManifestSigner;
  /**
   * When the source has no exhaustive lineage paging (`EvidenceSource.pageLineage` absent -- the
   * backing StoragePort does not implement it), fall back to a single bounded `listLineage` tail
   * window instead of throwing, and mark the manifest `complete: false`. Default false (fail closed):
   * an evidence pack silently missing events is worse than an export that refuses to run.
   */
  allowIncomplete?: boolean;
  /** Page size for `pageLineage` (default `MAX_LINEAGE_PAGE_SIZE`, the largest a StoragePort accepts). */
  pageSize?: number;
  /** Clock injection (tests, and the cross-language golden fixture, need a fixed `generatedAt`). */
  now?: () => Date;
}

/** One file to be written into the pack directory, keyed by its path relative to the pack root. */
export interface EvidencePackFile {
  path: string;
  content: Uint8Array;
}

/** The pack contents before signing (see sign.ts's `signManifest`, which turns this into `manifest.sig`). */
export interface BuiltEvidencePack {
  manifest: EvidenceManifest;
  files: EvidencePackFile[];
}

// Environment-neutral like the rest of @kohaku-ui/lineage's evidence module (no DOM lib / @types/node
// dependency): reach TextEncoder structurally, the same idiom spec-core's canonical-json.ts uses.
const runtime = globalThis as unknown as { TextEncoder: new () => { encode(input: string): Uint8Array } };
const encoder = new runtime.TextEncoder();

function jsonLines(records: readonly unknown[]): string {
  if (records.length === 0) return "";
  return `${records.map((r) => canonicalStringify(r)).join("\n")}\n`;
}

interface ArtifactCandidate {
  artifactId: string;
  html: string;
  /** The hash the source claimed for this html, if any (compared against the actual sha256 below). */
  claimedSha256?: string;
  /** Where this candidate was found, for the warning message only. */
  origin: string;
}

function collectArtifactCandidates(
  events: readonly LineageEventRecord[],
  promotions: readonly PromotionState[],
): ArtifactCandidate[] {
  const candidates: ArtifactCandidate[] = [];
  for (const event of events) {
    if (event.type !== "component.generated") continue;
    const html = event.payload["html"];
    const artifactId = event.payload["artifactId"];
    if (typeof html !== "string" || html.length === 0 || typeof artifactId !== "string") continue;
    const claimedSha256 = event.payload["artifactSha256"];
    candidates.push({
      artifactId,
      html,
      ...(typeof claimedSha256 === "string" ? { claimedSha256 } : {}),
      origin: "component.generated",
    });
  }
  for (const state of promotions) {
    const html = state.data["html"];
    if (typeof html !== "string" || html.length === 0) continue;
    const claimedSha256 = state.data["sha256"];
    candidates.push({
      artifactId: state.artifactId,
      html,
      ...(typeof claimedSha256 === "string" ? { claimedSha256 } : {}),
      origin: "promotion state",
    });
  }
  return candidates;
}

/**
 * Assembles a Compliance Evidence Pack (design.md #67) from an `EvidenceSource` -- normalized lineage
 * events, an approvals index, promotion/fixation snapshots, and the referenced component HTML
 * artifacts -- as an in-memory file set plus its (unsigned) manifest. Signing is a separate step (see
 * sign.ts's `signManifest`); writing the files to disk is the caller's responsibility (the CLI writes
 * them under `--out <dir>`).
 */
export async function buildEvidencePack(options: BuildEvidencePackOptions): Promise<BuiltEvidencePack> {
  const {
    source,
    scope,
    generator,
    signer,
    allowIncomplete = false,
    pageSize,
    now = () => new Date(),
  } = options;

  let events: LineageEventRecord[];
  let complete: boolean;
  if (source.pageLineage != null) {
    events = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await source.pageLineage({
        tenant: scope.tenant,
        since: scope.since,
        until: scope.until,
        cursor,
        pageSize,
      });
      events.push(...page.events);
      if (page.nextCursor == null) break;
      cursor = page.nextCursor;
    }
    complete = true;
  } else {
    if (!allowIncomplete) {
      throw new Error(
        "EvidenceSource has no pageLineage (the backing StoragePort does not implement it); pass " +
          "allowIncomplete to fall back to a bounded listLineage tail window instead of failing the export.",
      );
    }
    events = await source.listLineage({
      tenant: scope.tenant,
      since: scope.since,
      until: scope.until,
      limit: MAX_LINEAGE_PAGE_SIZE,
    });
    complete = false;
  }

  const approvals = events.filter((e) => EVIDENCE_APPROVAL_EVENT_TYPES.includes(e.type));
  const promotions = await source.listPromotionStates(scope.tenant);
  const fixations = await source.listFixations(scope.tenant);

  const warnings: string[] = [];
  // Keyed by the artifact's *actual* content hash, so the same html reached from two origins (e.g. a
  // component.generated event and its later published promotion state) is written once.
  const artifactsByHash = new Map<string, string>();
  for (const candidate of collectArtifactCandidates(events, promotions)) {
    const actualSha256 = await sha256Hex(candidate.html);
    if (!artifactsByHash.has(actualSha256)) artifactsByHash.set(actualSha256, candidate.html);
    if (candidate.claimedSha256 != null && candidate.claimedSha256 !== actualSha256) {
      warnings.push(
        `artifact ${candidate.artifactId}: recorded sha256 ${candidate.claimedSha256} does not match ` +
          `sha256 of its own html (${actualSha256}) [source: ${candidate.origin}]`,
      );
    }
  }

  const files: EvidencePackFile[] = [];
  const fileEntries: EvidenceFileEntry[] = [];

  async function addTextFile(path: string, text: string, records?: number): Promise<void> {
    const content = encoder.encode(text);
    const sha256 = await sha256Hex(text);
    files.push({ path, content });
    fileEntries.push({ path, sha256, bytes: content.byteLength, ...(records != null ? { records } : {}) });
  }

  await addTextFile("events.jsonl", jsonLines(events), events.length);
  await addTextFile("approvals.jsonl", jsonLines(approvals), approvals.length);
  await addTextFile("promotions.jsonl", jsonLines(promotions), promotions.length);
  await addTextFile("fixations.jsonl", jsonLines(fixations), fixations.length);

  // Sorted by hash so file order is deterministic and independent of Map insertion order (needed for
  // the cross-language golden fixture -- see spec/test/fixtures/evidence-pack/).
  for (const hash of [...artifactsByHash.keys()].sort()) {
    await addTextFile(`artifacts/${hash}.html`, artifactsByHash.get(hash)!);
  }

  const manifest: EvidenceManifest = {
    format: EVIDENCE_PACK_FORMAT,
    version: EVIDENCE_PACK_VERSION,
    generator,
    generatedAt: now().toISOString(),
    scope,
    counts: {
      events: events.length,
      approvals: approvals.length,
      promotions: promotions.length,
      fixations: fixations.length,
      artifacts: artifactsByHash.size,
    },
    complete,
    files: fileEntries,
    warnings,
    signer,
  };

  return { manifest, files };
}
