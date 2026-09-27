import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveEd25519KeyId } from "@kohaku-ui/lineage";
import { generateKeyPairPem } from "./keys.js";

export interface EvidenceKeygenOptions {
  /** Overwrite an existing key file instead of refusing. Default false. */
  force?: boolean;
}

export interface EvidenceKeygenResult {
  privateKeyPath: string;
  publicKeyPath: string;
  keyId: string;
}

/**
 * `kohaku evidence keygen --out-dir <dir> [--force]`: generates a fresh Ed25519 keypair for
 * signing/verifying Compliance Evidence Packs. The private key file is written with mode 0600 (owner
 * read/write only); `chmodSync` runs after the write as a belt-and-suspenders step since
 * `writeFileSync`'s own `mode` option is subject to the process umask narrowing it further but never
 * widening it back to 0600. `--out-dir` is a directory the caller names explicitly -- this command never
 * writes under a `--data-dir` (StoragePort data directory), keeping key material out of the tree an
 * evidence export itself reads from.
 *
 * Refuses to overwrite either key file unless `opts.force` is set: silently regenerating a keypair over
 * an existing one would orphan every already-signed pack (its signature can no longer be verified
 * against the new public key) and destroy the only private key that could re-sign anything, with no
 * warning at all. Even with `force`, the actual write is done with the exclusive-create flag when the
 * pre-check found nothing (`"wx"`), so a file created by a concurrent process between the check and the
 * write is still not silently clobbered by this invocation alone.
 */
export async function runEvidenceKeygen(
  outDir: string,
  opts: EvidenceKeygenOptions = {},
): Promise<EvidenceKeygenResult> {
  mkdirSync(outDir, { recursive: true });
  const privateKeyPath = join(outDir, "evidence-private-key.pem");
  const publicKeyPath = join(outDir, "evidence-public-key.pem");

  if (opts.force !== true) {
    const existing = [privateKeyPath, publicKeyPath].filter((p) => existsSync(p));
    if (existing.length > 0) {
      throw new Error(
        `${existing.join(" and ")} already exist(s); pass --force to overwrite (this permanently ` +
          "invalidates the signature of every evidence pack signed with the old key)",
      );
    }
  }

  const { privateKeyPem, publicKeyPem, publicKeyRaw } = await generateKeyPairPem();

  // "wx": exclusive create -- fails with EEXIST if the file appeared after the existsSync check above
  // (e.g. a second concurrent `keygen` invocation), closing that TOCTOU gap. "w" (force) intentionally
  // allows the overwrite the caller explicitly asked for.
  const flag = opts.force === true ? "w" : "wx";
  writeFileSync(privateKeyPath, privateKeyPem, { mode: 0o600, flag });
  chmodSync(privateKeyPath, 0o600);
  writeFileSync(publicKeyPath, publicKeyPem, { flag });

  const keyId = await deriveEd25519KeyId(publicKeyRaw);
  return { privateKeyPath, publicKeyPath, keyId };
}
