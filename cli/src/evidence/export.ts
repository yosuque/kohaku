import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createKohakuClient, type Transport } from "@kohaku-ui/client";
import {
  buildEvidencePack,
  createStorageEvidenceSource,
  deriveEd25519KeyId,
  type EvidenceManifest,
  signManifest,
} from "@kohaku-ui/lineage";
import { createFileStoragePort } from "@kohaku-ui/storage-memory";
import { parseHeaderArgs } from "../commands.js";
import { CLI_VERSION } from "../version.js";
import { importPrivateKeyPem } from "./keys.js";
import { createRestEvidenceSource, REST_FIXATIONS_LIMITATION_WARNING } from "./rest-source.js";

export interface EvidenceExportOptions {
  /** Read the pack from a local StoragePort data directory (mutually exclusive with `rest`). */
  dataDir?: string;
  /** Read the pack over REST from a running host (mutually exclusive with `dataDir`). */
  rest?: string;
  /** Extra REST request headers ("name:value", repeatable) -- e.g. tenant / auth. REST mode only. */
  headers?: string[];
  tenant?: string;
  since: string;
  until: string;
  /** Path to a PEM-encoded Ed25519 private key (PKCS8, `-----BEGIN PRIVATE KEY-----`). */
  privateKeyPath: string;
  outDir: string;
  allowIncomplete?: boolean;
  /** Transport override (no CLI flag; REST mode tests inject an in-process Hono app's `app.request`). */
  transport?: Transport;
}

export interface EvidenceExportResult {
  outDir: string;
  manifest: EvidenceManifest;
}

/**
 * `kohaku evidence export`: assembles and signs a Compliance Evidence Pack (design.md #67), then writes
 * it to `--out <dir>` (events.jsonl / approvals.jsonl / promotions.jsonl / fixations.jsonl /
 * artifacts/<sha256>.html / manifest.json / manifest.sig).
 */
export async function runEvidenceExport(opts: EvidenceExportOptions): Promise<EvidenceExportResult> {
  if (opts.dataDir == null && opts.rest == null) {
    throw new Error("Specify either --data-dir <dir> or --rest <baseUrl>");
  }
  if (opts.dataDir != null && opts.rest != null) {
    throw new Error("Specify only one of --data-dir or --rest, not both");
  }

  const restFixationsWarning = opts.rest != null ? REST_FIXATIONS_LIMITATION_WARNING : undefined;
  const source =
    opts.dataDir != null
      ? createStorageEvidenceSource(createFileStoragePort(opts.dataDir))
      : createRestEvidenceSource(
          createKohakuClient({
            baseUrl: opts.rest!.replace(/\/$/, ""),
            headers: () => parseHeaderArgs(opts.headers),
            ...(opts.transport != null ? { transport: opts.transport } : {}),
          }),
        );

  let privateKeyPem: string;
  try {
    privateKeyPem = readFileSync(opts.privateKeyPath, "utf8");
  } catch (e) {
    throw new Error(
      `Cannot read --private-key ${opts.privateKeyPath} (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const { privateKey, publicKeyRaw } = await importPrivateKeyPem(privateKeyPem);
  const keyId = await deriveEd25519KeyId(publicKeyRaw);

  const pack = await buildEvidencePack({
    source,
    scope: { tenant: opts.tenant, since: opts.since, until: opts.until },
    generator: `kohaku-cli/${CLI_VERSION}`,
    signer: { alg: "Ed25519", keyId },
    allowIncomplete: opts.allowIncomplete,
  });
  // A structural REST limitation (see rest-source.ts), not a build-time data-quality issue -- appended
  // after buildEvidencePack rather than threaded through it, since it applies to the source, not the
  // records buildEvidencePack itself inspects. Recorded before signing, so it is part of what is signed.
  if (restFixationsWarning != null) {
    pack.manifest.warnings.push(restFixationsWarning);
  }

  const signature = await signManifest(pack.manifest, privateKey);

  mkdirSync(opts.outDir, { recursive: true });
  for (const file of pack.files) {
    const filePath = join(opts.outDir, file.path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, file.content);
  }
  writeFileSync(join(opts.outDir, "manifest.json"), `${JSON.stringify(pack.manifest, null, 2)}\n`);
  writeFileSync(join(opts.outDir, "manifest.sig"), `${signature}\n`);

  return { outDir: opts.outDir, manifest: pack.manifest };
}
