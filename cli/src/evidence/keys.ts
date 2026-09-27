import { createPrivateKey, createPublicKey, KeyObject } from "node:crypto";
import {
  type Ed25519PrivateKey,
  type Ed25519PublicKey,
  exportEd25519PublicKeyRaw,
  generateEd25519KeyPair,
  importEd25519PrivateKeyPkcs8,
  importEd25519PublicKeySpki,
} from "@kohaku-ui/lineage";

/**
 * Bridges @kohaku-ui/lineage's WebCrypto Ed25519 keys (environment-neutral, opaque `object` types) to
 * PEM text for the CLI's on-disk key files. Node's `node:crypto` `KeyObject` interoperates with WebCrypto
 * `CryptoKey` via `KeyObject.from()`, and does PEM encode/decode itself -- there is no need for a
 * hand-rolled PEM writer here, unlike lineage's own base64 handling (which has no `node:crypto` to lean on
 * since it stays environment-neutral).
 */

export interface GeneratedKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
  publicKeyRaw: Uint8Array;
}

/** Generates a fresh Ed25519 keypair as PEM text (`kohaku evidence keygen`). */
export async function generateKeyPairPem(): Promise<GeneratedKeyPair> {
  const keyPair = await generateEd25519KeyPair();
  const privateKeyObject = webCryptoKeyToKeyObject(keyPair.privateKey);
  const publicKeyObject = webCryptoKeyToKeyObject(keyPair.publicKey);
  const privateKeyPem = privateKeyObject.export({ type: "pkcs8", format: "pem" }) as string;
  const publicKeyPem = publicKeyObject.export({ type: "spki", format: "pem" }) as string;
  const publicKeyRaw = await exportEd25519PublicKeyRaw(keyPair.publicKey);
  return { privateKeyPem, publicKeyPem, publicKeyRaw };
}

function webCryptoKeyToKeyObject(key: Ed25519PrivateKey | Ed25519PublicKey): KeyObject {
  // KeyObject.from's declared parameter type is Node's own webcrypto.CryptoKey, which is structurally the
  // same object @kohaku-ui/lineage returns but keeps as an opaque `object` (see sign.ts) so it carries no
  // DOM-lib dependency; this cast is the CLI-side bridge back to Node's own type.
  return KeyObject.from(key as unknown as Parameters<typeof KeyObject.from>[0]);
}

export interface ImportedPrivateKey {
  privateKey: Ed25519PrivateKey;
  /** Derived from the private key (Node's `createPublicKey` supports this for Ed25519/X25519). Used to
   * compute `manifest.signer.keyId` without requiring the caller to also supply the public key file. */
  publicKeyRaw: Uint8Array;
}

/** Imports a PEM-encoded Ed25519 private key (PKCS8, `-----BEGIN PRIVATE KEY-----`). */
export async function importPrivateKeyPem(pem: string): Promise<ImportedPrivateKey> {
  const privateKeyObject = createPrivateKey(pem);
  const publicKeyObject = createPublicKey(privateKeyObject);
  const pkcs8 = privateKeyObject.export({ type: "pkcs8", format: "der" }) as Buffer;
  const spki = publicKeyObject.export({ type: "spki", format: "der" }) as Buffer;
  const privateKey = await importEd25519PrivateKeyPkcs8(new Uint8Array(pkcs8));
  const publicKey = await importEd25519PublicKeySpki(new Uint8Array(spki));
  const publicKeyRaw = await exportEd25519PublicKeyRaw(publicKey);
  return { privateKey, publicKeyRaw };
}

/** Imports a PEM-encoded Ed25519 public key (SPKI, `-----BEGIN PUBLIC KEY-----`), for `kohaku evidence verify`. */
export async function importPublicKeyPem(pem: string): Promise<Ed25519PublicKey> {
  const publicKeyObject = createPublicKey(pem);
  const spki = publicKeyObject.export({ type: "spki", format: "der" }) as Buffer;
  return importEd25519PublicKeySpki(new Uint8Array(spki));
}
