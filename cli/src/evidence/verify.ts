import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  type EvidencePackReader,
  type VerifyEvidencePackResult,
  verifyEvidencePack,
} from "@kohaku-ui/lineage";
import { importPublicKeyPem } from "./keys.js";

/**
 * Resolves `relativePath` inside `rootReal` (`rootReal` must already be `realpathSync`-resolved),
 * refusing anything that is not a plain regular file physically inside it, and returns its real,
 * fully-resolved path. `relativePath` ultimately comes from `manifest.files[].path` -- data inside a
 * manifest a verifier is, by definition, not yet sure it can trust -- so this closes both path traversal
 * (`..`, an absolute path) and a symlink escape, even though `EvidenceFileEntrySchema` (and
 * `verifyEvidencePack`'s own re-check) already constrain the path's string shape: this function does not
 * rely on either of those continuing to hold. Shared by `safeReadFile` and `safeStatSize` so a size check
 * and the read it may precede are guaranteed to resolve to the exact same on-disk target.
 */
function resolveSafePath(rootReal: string, relativePath: string): string {
  const target = resolve(rootReal, relativePath);
  if (target !== rootReal && !target.startsWith(rootReal + sep)) {
    throw new Error(`refusing to access "${relativePath}": escapes the pack directory`);
  }
  // lstat (not stat): a symlink at the leaf position is refused outright, regardless of where it
  // points -- a legitimate evidence pack is a plain export directory and should never contain one.
  const lstat = lstatSync(target);
  if (lstat.isSymbolicLink()) {
    throw new Error(`refusing to access "${relativePath}": it is a symlink`);
  }
  // realpath additionally resolves a symlinked *intermediate* directory component (e.g. "artifacts"
  // itself being a symlink), which lstat on the leaf alone cannot detect.
  const realTarget = realpathSync(target);
  if (realTarget !== rootReal && !realTarget.startsWith(rootReal + sep)) {
    throw new Error(`refusing to access "${relativePath}": resolves outside the pack directory`);
  }
  return realTarget;
}

function safeReadFile(rootReal: string, relativePath: string): Uint8Array {
  return new Uint8Array(readFileSync(resolveSafePath(rootReal, relativePath)));
}

/** The on-disk byte size of `relativePath`, without reading its content -- `EvidencePackReader.size`'s
 * implementation, so `verifyEvidencePack` can refuse an oversized or size-mismatched file before this
 * module ever buffers it into memory via `safeReadFile`. */
function safeStatSize(rootReal: string, relativePath: string): number {
  return statSync(resolveSafePath(rootReal, relativePath)).size;
}

/** Lists every regular file (and, deliberately, every symlink -- so one shows up as an "unexpected
 * file" rather than being silently skipped) under `dir`, as POSIX-style paths relative to `root`. */
function listFilesRecursive(root: string, dir: string, acc: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const relPath = relative(root, full).split(sep).join("/");
    if (entry.isSymbolicLink()) {
      acc.push(relPath);
      continue;
    }
    if (entry.isDirectory()) {
      listFilesRecursive(root, full, acc);
    } else if (entry.isFile()) {
      acc.push(relPath);
    }
  }
  return acc;
}

/** Reads a pack directory on disk for `verifyEvidencePack` (Node fs, synchronous reads wrapped as async
 * to satisfy the `EvidencePackReader` contract). */
function directoryReader(dir: string): EvidencePackReader {
  // Resolved once, eagerly: every read is checked against this real path, not the possibly-symlinked
  // `dir` the caller passed in (a symlinked --data-dir style argument is the user's own choice; what
  // matters here is that every *file inside* the pack resolves within this same real root).
  const rootReal = realpathSync(dir);
  return {
    async readManifest() {
      return safeReadFile(rootReal, "manifest.json");
    },
    async readSignature() {
      return safeReadFile(rootReal, "manifest.sig");
    },
    async readFile(path: string) {
      return safeReadFile(rootReal, path);
    },
    async listFiles() {
      return listFilesRecursive(rootReal, rootReal);
    },
    async size(path: string) {
      return safeStatSize(rootReal, path);
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
