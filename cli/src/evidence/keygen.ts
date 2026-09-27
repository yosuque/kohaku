import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveEd25519KeyId } from "@kohaku-ui/lineage";
import { generateKeyPairPem } from "./keys.js";

export interface EvidenceKeygenResult {
  privateKeyPath: string;
  publicKeyPath: string;
  keyId: string;
}

/**
 * `kohaku evidence keygen --out-dir <dir>`: generates a fresh Ed25519 keypair for signing/verifying
 * Compliance Evidence Packs. The private key file is written with mode 0600 (owner read/write only);
 * `chmodSync` runs after the write as a belt-and-suspenders step since `writeFileSync`'s own `mode`
 * option is subject to the process umask narrowing it further but never widening it back to 0600.
 * `--out-dir` is a directory the caller names explicitly -- this command never writes under a
 * `--data-dir` (StoragePort data directory), keeping key material out of the tree an evidence export
 * itself reads from.
 */
export async function runEvidenceKeygen(outDir: string): Promise<EvidenceKeygenResult> {
  mkdirSync(outDir, { recursive: true });
  const { privateKeyPem, publicKeyPem, publicKeyRaw } = await generateKeyPairPem();

  const privateKeyPath = join(outDir, "evidence-private-key.pem");
  const publicKeyPath = join(outDir, "evidence-public-key.pem");

  writeFileSync(privateKeyPath, privateKeyPem, { mode: 0o600 });
  chmodSync(privateKeyPath, 0o600);
  writeFileSync(publicKeyPath, publicKeyPem);

  const keyId = await deriveEd25519KeyId(publicKeyRaw);
  return { privateKeyPath, publicKeyPath, keyId };
}
