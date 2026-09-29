import { canonicalStringify, type LineageEventRecord, type PromotionState } from "@kohaku-ui/spec-core";
import { artifactClaimFromEventPayload, artifactClaimFromPromotionData } from "./artifacts.js";
import {
  type EvidenceManifest,
  EvidenceManifestSchema,
  isSafeEvidenceFilePath,
  MAX_EVIDENCE_FILE_BYTES,
} from "./manifest.js";

/**
 * Opaque handles for WebCrypto Ed25519 key material. Kept untyped/structural (`object`, not the DOM
 * lib's `CryptoKey`) because @kohaku-ui/lineage -- like spec-core -- carries no DOM lib / @types/node
 * dependency; see the `runtime` cast below, the same idiom spec-core's canonical-json.ts uses for
 * `TextEncoder` / `crypto.subtle`.
 */
export type Ed25519PrivateKey = object;
export type Ed25519PublicKey = object;

export interface Ed25519KeyPair {
  privateKey: Ed25519PrivateKey;
  publicKey: Ed25519PublicKey;
}

const runtime = globalThis as unknown as {
  TextEncoder: new () => { encode(input: string): Uint8Array };
  TextDecoder: new () => { decode(input: Uint8Array): string };
  btoa(data: string): string;
  atob(data: string): string;
  crypto: {
    subtle: {
      digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
      sign(algorithm: "Ed25519", key: Ed25519PrivateKey, data: Uint8Array): Promise<ArrayBuffer>;
      verify(
        algorithm: "Ed25519",
        key: Ed25519PublicKey,
        signature: Uint8Array,
        data: Uint8Array,
      ): Promise<boolean>;
      generateKey(
        algorithm: { name: "Ed25519" },
        extractable: boolean,
        keyUsages: readonly string[],
      ): Promise<Ed25519KeyPair>;
      exportKey(
        format: "raw" | "pkcs8" | "spki",
        key: Ed25519PrivateKey | Ed25519PublicKey,
      ): Promise<ArrayBuffer>;
      importKey(
        format: "raw" | "pkcs8" | "spki",
        keyData: Uint8Array,
        algorithm: { name: "Ed25519" },
        extractable: boolean,
        keyUsages: readonly string[],
      ): Promise<Ed25519PrivateKey | Ed25519PublicKey>;
    };
  };
};

const encoder = new runtime.TextEncoder();
const decoder = new runtime.TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return runtime.btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = runtime.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await runtime.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Generates a fresh Ed25519 keypair (`kohaku evidence keygen`). */
export async function generateEd25519KeyPair(): Promise<Ed25519KeyPair> {
  return runtime.crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
}

/** Exports a private key as PKCS8 DER bytes (the CLI PEM-encodes this as `-----BEGIN PRIVATE KEY-----`). */
export async function exportEd25519PrivateKeyPkcs8(key: Ed25519PrivateKey): Promise<Uint8Array> {
  return new Uint8Array(await runtime.crypto.subtle.exportKey("pkcs8", key));
}

/** Exports a public key as SPKI DER bytes (the CLI PEM-encodes this as `-----BEGIN PUBLIC KEY-----`). */
export async function exportEd25519PublicKeySpki(key: Ed25519PublicKey): Promise<Uint8Array> {
  return new Uint8Array(await runtime.crypto.subtle.exportKey("spki", key));
}

/** Exports a public key as raw bytes (the 32-byte Ed25519 point) -- `deriveEd25519KeyId`'s input. */
export async function exportEd25519PublicKeyRaw(key: Ed25519PublicKey): Promise<Uint8Array> {
  return new Uint8Array(await runtime.crypto.subtle.exportKey("raw", key));
}

/** Imports an Ed25519 private key from PKCS8 DER bytes. */
export async function importEd25519PrivateKeyPkcs8(pkcs8: Uint8Array): Promise<Ed25519PrivateKey> {
  return runtime.crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
}

/** Imports an Ed25519 public key from SPKI DER bytes. */
export async function importEd25519PublicKeySpki(spki: Uint8Array): Promise<Ed25519PublicKey> {
  return runtime.crypto.subtle.importKey("spki", spki, { name: "Ed25519" }, true, ["verify"]);
}

/** Imports an Ed25519 public key from raw bytes (the 32-byte point) -- used directly by an RFC 8032 test vector. */
export async function importEd25519PublicKeyRaw(raw: Uint8Array): Promise<Ed25519PublicKey> {
  return runtime.crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, true, ["verify"]);
}

/**
 * `manifest.signer.keyId`: the first 16 hex characters of sha256 of the raw public key bytes -- enough
 * to pick the right key out of a small set, not a full fingerprint.
 */
export async function deriveEd25519KeyId(publicKeyRaw: Uint8Array): Promise<string> {
  return (await sha256HexBytes(publicKeyRaw)).slice(0, 16);
}

/**
 * Signs an arbitrary byte message with an Ed25519 private key -- the primitive `signManifest` builds
 * on. Exposed on its own so it can be exercised directly against a standard test vector (RFC 8032
 * §7.1, TEST 1) without going through manifest canonicalization.
 */
export async function signBytes(message: Uint8Array, privateKey: Ed25519PrivateKey): Promise<Uint8Array> {
  return new Uint8Array(await runtime.crypto.subtle.sign("Ed25519", privateKey, message));
}

/** Verifies an arbitrary byte message's Ed25519 signature -- the primitive `verifyManifestSignature` builds on. */
export async function verifyBytes(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Ed25519PublicKey,
): Promise<boolean> {
  return runtime.crypto.subtle.verify("Ed25519", publicKey, signature, message);
}

/**
 * Signs a manifest's canonical JSON form with an Ed25519 private key. Returns the base64 signature --
 * the exact text `manifest.sig` holds. `manifest.signer.keyId` must already match the given key (see
 * build.ts's `BuildEvidencePackOptions.signer`, computed by the caller via `deriveEd25519KeyId` before
 * calling `buildEvidencePack`); `signManifest` does not itself check this.
 */
export async function signManifest(
  manifest: EvidenceManifest,
  privateKey: Ed25519PrivateKey,
): Promise<string> {
  const signature = await signBytes(encoder.encode(canonicalStringify(manifest)), privateKey);
  return bytesToBase64(signature);
}

/**
 * Verifies a manifest's signature (`manifest.sig`'s base64 contents) against an Ed25519 public key.
 * `manifest` is whatever JSON value was signed: `verifyEvidencePack` passes the raw `JSON.parse` result
 * of manifest.json (not a schema-parsed copy, which would silently drop unknown keys and so verify
 * content the signer never covered). A malformed signature is a failed verification, not a throw.
 */
export async function verifyManifestSignature(
  manifest: unknown,
  signatureBase64: string,
  publicKey: Ed25519PublicKey,
): Promise<boolean> {
  const message = encoder.encode(canonicalStringify(manifest));
  let signature: Uint8Array;
  try {
    signature = base64ToBytes(signatureBase64.trim());
  } catch {
    return false;
  }
  return verifyBytes(message, signature, publicKey);
}

/**
 * Reads a built pack's contents back for `verifyEvidencePack`. @kohaku-ui/lineage has no filesystem
 * access of its own (environment-neutral), so the CLI (or any other caller) supplies this over
 * whatever storage the pack actually lives on (a local directory, in the CLI's case).
 */
export interface EvidencePackReader {
  /** Raw bytes of manifest.json. */
  readManifest(): Promise<Uint8Array>;
  /** Raw bytes of manifest.sig (the base64 signature text; a trailing newline is tolerated). */
  readSignature(): Promise<Uint8Array>;
  /** Raw bytes of a file listed in the manifest's `files[]`, addressed by its recorded `path`. */
  readFile(path: string): Promise<Uint8Array>;
  /**
   * Every path physically present in the pack, relative to the pack root, in the same string form as
   * `manifest.files[].path` (plus `"manifest.json"` / `"manifest.sig"` themselves). Used by
   * `verifyEvidencePack` to catch a file smuggled into an otherwise-valid pack that the (signed)
   * manifest never lists -- a signature over the manifest alone cannot detect an *addition* to the
   * pack directory, only a change to something the manifest already references.
   */
  listFiles(): Promise<string[]>;
  /**
   * Optional: the byte size of `"manifest.json"`, `"manifest.sig"`, or a `files[]` entry's `path`,
   * without reading its content. When implemented, `verifyEvidencePack` checks it against the expected
   * size (a fixed cap for the two fixed filenames, or the signed manifest's own recorded `bytes` for a
   * `files[]` entry) *before* ever calling `readManifest`/`readSignature`/`readFile` for that path --
   * bounding how much of an untrusted pack's oversized or size-mismatched content this function will
   * buffer into memory. A reader that omits this still gets the same hash/size cross-check, just after
   * the (potentially large) read.
   */
  size?(path: string): Promise<number>;
}

/** Hard caps `verifyEvidencePack` enforces before reading, independent of what any particular reader's
 * `size()` reports -- a legitimately-signed manifest should never need a file this large, and refusing
 * outright is simpler and safer than trying to stream-hash an arbitrarily large one. */
const MAX_MANIFEST_JSON_BYTES = 16 * 1024 * 1024; // 16 MiB
const MAX_MANIFEST_SIG_BYTES = 1 * 1024 * 1024; // 1 MiB (a base64 Ed25519 signature is ~88 bytes)
const MAX_FILE_BYTES = MAX_EVIDENCE_FILE_BYTES; // shared with buildEvidencePack, so a built pack verifies

/** `reader.size?.(path)`, tolerating a reader that doesn't implement it (returns undefined) or one whose
 * `size()` throws for this path (also undefined -- the subsequent read will surface its own error). */
async function trySize(reader: EvidencePackReader, path: string): Promise<number | undefined> {
  if (reader.size == null) return undefined;
  try {
    return await reader.size(path);
  } catch {
    return undefined;
  }
}

export interface VerifyEvidencePackResult {
  ok: boolean;
  /** The parsed manifest, present only once its signature verified and it matched EvidenceManifestSchema. */
  manifest?: EvidenceManifest;
  /**
   * Fatal integrity problems: a malformed manifest, a signature that does not verify (over the raw
   * manifest.json value, so an added, removed or retyped field fails here), a `files[]` entry
   * whose on-disk hash/size does not match what the (signed) manifest recorded, or a file that could
   * not be read at all. Any entry here means `ok` is false -- these are exactly the class of problem a
   * single-byte tamper produces.
   */
  errors: string[];
  /**
   * Non-fatal cross-checks found while independently re-scanning the artifact-bearing records inside
   * events.jsonl / approvals.jsonl / promotions.jsonl: a record's own claimed artifact hash
   * (`artifactSha256` / `data.sha256`) that does not match sha256 of the html it names. Does not affect
   * `ok` -- this reflects a data-quality issue already present in the source system at export time
   * (build.ts records the same class of issue on `manifest.warnings`), not corruption of the pack
   * itself.
   */
  mismatches: string[];
}

function parseJsonlRecords(text: string): unknown[] {
  const records: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Malformed JSONL is reported by the caller as a files[] hash mismatch already (the file's
      // content no longer matches what was signed); re-parsing here is only a best-effort artifact
      // cross-check, so a line that fails to parse is simply skipped rather than raised twice.
    }
  }
  return records;
}

/** Re-derives the artifact claims a jsonl file's own records make, by the same rules build.ts used to
 * collect them in the first place (see artifacts.ts). */
function artifactClaimsFromJsonlRecords(
  path: string,
  records: readonly unknown[],
): { artifactId: string; html: string; claimedSha256?: string }[] {
  const claims: { artifactId: string; html: string; claimedSha256?: string }[] = [];
  for (const record of records) {
    if (typeof record !== "object" || record === null) continue;
    if (path === "events.jsonl" || path === "approvals.jsonl") {
      const event = record as Partial<LineageEventRecord>;
      if (typeof event.type !== "string" || event.payload == null) continue;
      const claim = artifactClaimFromEventPayload(event.type, event.payload as Record<string, unknown>);
      if (claim != null) claims.push(claim);
    } else if (path === "promotions.jsonl") {
      const state = record as Partial<PromotionState>;
      if (typeof state.artifactId !== "string" || state.data == null) continue;
      const claim = artifactClaimFromPromotionData(state.artifactId, state.data as Record<string, unknown>);
      if (claim != null) claims.push(claim);
    }
  }
  return claims;
}

/**
 * Verifies a Compliance Evidence Pack (design.md #67): the manifest's signature verifies against
 * `publicKey` over the raw manifest.json value, the manifest then matches `EvidenceManifestSchema`, the pack directory contains no file the manifest does not
 * list, every file the manifest lists has the exact hash/size the manifest recorded, and -- as an
 * independent, best-effort cross-check -- every artifact reference found inside the jsonl files
 * actually hashes to the value it claims. A single altered byte anywhere the manifest covers changes
 * that file's hash (or, for manifest.json itself, the signed value), so either check catches it.
 *
 * Fails closed on a bad signature: once the signature does not verify, nothing else about the manifest
 * can be trusted (including the very `files[]` list that drives every other check), so this returns
 * immediately without reading a single other file from `reader`.
 */
export async function verifyEvidencePack(
  reader: EvidencePackReader,
  publicKey: Ed25519PublicKey,
): Promise<VerifyEvidencePackResult> {
  const manifestSize = await trySize(reader, "manifest.json");
  if (manifestSize != null && manifestSize > MAX_MANIFEST_JSON_BYTES) {
    return {
      ok: false,
      errors: [
        `manifest.json is ${manifestSize} bytes, exceeding the ${MAX_MANIFEST_JSON_BYTES}-byte cap; refusing to read it`,
      ],
      mismatches: [],
    };
  }
  const manifestBytes = await reader.readManifest();
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(manifestBytes));
  } catch (e) {
    return {
      ok: false,
      errors: [`manifest.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`],
      mismatches: [],
    };
  }

  const signatureSize = await trySize(reader, "manifest.sig");
  if (signatureSize != null && signatureSize > MAX_MANIFEST_SIG_BYTES) {
    return {
      ok: false,
      errors: [
        `manifest.sig is ${signatureSize} bytes, exceeding the ${MAX_MANIFEST_SIG_BYTES}-byte cap; refusing to read it`,
      ],
      mismatches: [],
    };
  }
  const signatureText = decoder.decode(await reader.readSignature()).trim();
  // The signature is checked over the raw parsed JSON, before schema validation: EvidenceManifestSchema
  // is not the signed value (an unknown key would be dropped by a lax parse and still verify).
  const signatureOk = await verifyManifestSignature(raw, signatureText, publicKey);
  if (!signatureOk) {
    return {
      ok: false,
      errors: ["manifest.sig does not verify against the given public key for this manifest"],
      mismatches: [],
    };
  }
  const parsed = EvidenceManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: [`manifest.json does not match EvidenceManifestSchema: ${parsed.error.message}`],
      mismatches: [],
    };
  }
  const manifest: EvidenceManifest = parsed.data;

  const errors: string[] = [];
  const mismatches: string[] = [];

  // The manifest is now signature-verified, so its own files[] list is trustworthy -- but the pack
  // directory itself might still carry a file that list never mentions (smuggled in after signing,
  // since a signature over the manifest cannot itself notice an addition to the directory).
  const listedPaths = new Set(manifest.files.map((f) => f.path));
  const actualPaths = await reader.listFiles();
  const unexpected = actualPaths.filter(
    (p) => p !== "manifest.json" && p !== "manifest.sig" && !listedPaths.has(p),
  );
  if (unexpected.length > 0) {
    errors.push(
      `unexpected file(s) present in the pack but not listed in the manifest: ${unexpected.join(", ")}`,
    );
  }

  for (const entry of manifest.files) {
    // Defense in depth: EvidenceFileEntrySchema already constrains `path` to a closed set of safe
    // shapes, so this should never actually fail for a manifest that parsed -- but the read that
    // follows drives a filesystem access from data this function does not otherwise re-validate, so
    // the check is repeated here rather than relying solely on the schema continuing to enforce it.
    if (!isSafeEvidenceFilePath(entry.path)) {
      errors.push(`${entry.path}: not a safe evidence-pack path, refusing to read it`);
      continue;
    }
    // Bounded reads: refuse before ever calling readFile, rather than buffering an oversized or
    // size-mismatched file into memory only to discover the mismatch afterward (see EvidencePackReader's
    // `size` doc comment). The manifest's own `entry.bytes` cap applies even without a `size()` reader;
    // the on-disk-size-vs-`entry.bytes` check additionally needs one.
    if (entry.bytes > MAX_FILE_BYTES) {
      errors.push(
        `${entry.path}: manifest records ${entry.bytes} bytes, exceeding the ${MAX_FILE_BYTES}-byte cap; refusing to read it`,
      );
      continue;
    }
    const actualSize = await trySize(reader, entry.path);
    if (actualSize != null && actualSize !== entry.bytes) {
      errors.push(`${entry.path}: is ${actualSize} bytes on disk, manifest records ${entry.bytes}`);
      continue;
    }
    let content: Uint8Array;
    try {
      content = await reader.readFile(entry.path);
    } catch (e) {
      errors.push(`${entry.path}: could not be read (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    if (content.byteLength !== entry.bytes) {
      errors.push(`${entry.path}: is ${content.byteLength} bytes on disk, manifest records ${entry.bytes}`);
    }
    const actualSha256 = await sha256HexBytes(content);
    if (actualSha256 !== entry.sha256) {
      errors.push(`${entry.path}: sha256 on disk is ${actualSha256}, manifest records ${entry.sha256}`);
      continue; // The content is not what was signed; an artifact cross-check against it would be meaningless.
    }
    if (entry.path.endsWith(".jsonl") && content.byteLength > 0) {
      const records = parseJsonlRecords(decoder.decode(content));
      for (const claim of artifactClaimsFromJsonlRecords(entry.path, records)) {
        if (claim.claimedSha256 == null) continue;
        const actual = await sha256HexBytes(encoder.encode(claim.html));
        if (actual !== claim.claimedSha256) {
          mismatches.push(
            `${entry.path}: artifact ${claim.artifactId} claims sha256 ${claim.claimedSha256}, ` +
              `but sha256 of its own html is ${actual}`,
          );
        }
      }
    }
  }

  return { ok: errors.length === 0, manifest, errors, mismatches };
}
