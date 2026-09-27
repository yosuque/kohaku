import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type EvidencePackReader,
  type VerifyEvidencePackResult,
  verifyEvidencePack,
} from "@kohaku-ui/lineage";
import { importPublicKeyPem } from "./keys.js";

/** Reads a pack directory on disk for `verifyEvidencePack` (Node fs, synchronous reads wrapped as async
 * to satisfy the `EvidencePackReader` contract). */
function directoryReader(dir: string): EvidencePackReader {
  return {
    async readManifest() {
      return new Uint8Array(readFileSync(join(dir, "manifest.json")));
    },
    async readSignature() {
      return new Uint8Array(readFileSync(join(dir, "manifest.sig")));
    },
    async readFile(path: string) {
      return new Uint8Array(readFileSync(join(dir, path)));
    },
  };
}

/**
 * `kohaku evidence verify <dir>`: verifies a Compliance Evidence Pack directory against a PEM-encoded
 * Ed25519 public key. Exit code convention (see index.ts): 0 = valid, 1 = invalid, 2 = usage error.
 */
export async function runEvidenceVerify(
  dir: string,
  publicKeyPath: string,
): Promise<VerifyEvidencePackResult> {
  let publicKeyPem: string;
  try {
    publicKeyPem = readFileSync(publicKeyPath, "utf8");
  } catch (e) {
    throw new Error(
      `Cannot read --public-key ${publicKeyPath} (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const publicKey = await importPublicKeyPem(publicKeyPem);
  return verifyEvidencePack(directoryReader(dir), publicKey);
}
