import { describe, expect, it } from "vitest";
import { buildEvidencePack } from "../src/evidence/build.js";
import type { EvidenceManifest } from "../src/evidence/manifest.js";
import {
  deriveEd25519KeyId,
  type EvidencePackReader,
  exportEd25519PrivateKeyPkcs8,
  exportEd25519PublicKeyRaw,
  exportEd25519PublicKeySpki,
  generateEd25519KeyPair,
  importEd25519PrivateKeyPkcs8,
  importEd25519PublicKeyRaw,
  importEd25519PublicKeySpki,
  sha256HexBytes,
  signBytes,
  signManifest,
  verifyBytes,
  verifyEvidencePack,
  verifyManifestSignature,
} from "../src/evidence/sign.js";
import type { EvidenceSource } from "../src/evidence/source.js";

// lineage carries no DOM lib / @types/node dependency; reach TextEncoder structurally, the same idiom
// src/evidence/sign.ts itself uses.
const runtime = globalThis as unknown as { TextEncoder: new () => { encode(input: string): Uint8Array } };
const encoder = new runtime.TextEncoder();

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// PKCS8 DER for an Ed25519 private key is a fixed 16-byte prefix followed by the raw 32-byte seed --
// there are no algorithm parameters to vary, so this constant plus the seed is the whole encoding.
const ED25519_PKCS8_PREFIX = "302e020100300506032b657004220420";

/**
 * RFC 8032 §7.1, TEST 1 -- the canonical Ed25519 test vector (empty message). Independently
 * cross-checked (not just transcribed): importing this SECRET_KEY_SEED via WebCrypto's pkcs8 import
 * and deriving its public key (via a JWK export) reproduces PUBLIC_KEY exactly, and signing the empty
 * message with it reproduces SIGNATURE exactly.
 */
const RFC8032_TEST1 = {
  secretKeySeed: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  publicKey: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  signature:
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
};

describe("Ed25519 primitives against RFC 8032 §7.1 TEST 1", () => {
  it("verifies the canonical (secret key, empty message, signature) triple", async () => {
    const publicKey = await importEd25519PublicKeyRaw(hexToBytes(RFC8032_TEST1.publicKey));
    const ok = await verifyBytes(new Uint8Array(0), hexToBytes(RFC8032_TEST1.signature), publicKey);
    expect(ok).toBe(true);
  });

  it("reproduces the canonical signature when signing with the matching private key", async () => {
    const pkcs8 = hexToBytes(ED25519_PKCS8_PREFIX + RFC8032_TEST1.secretKeySeed);
    const privateKey = await importEd25519PrivateKeyPkcs8(pkcs8);
    const signature = await signBytes(new Uint8Array(0), privateKey);
    expect(bytesToHex(signature)).toBe(RFC8032_TEST1.signature);
  });

  it("fails verification when a single signature byte is flipped", async () => {
    const publicKey = await importEd25519PublicKeyRaw(hexToBytes(RFC8032_TEST1.publicKey));
    const tampered = hexToBytes(RFC8032_TEST1.signature);
    tampered[0] ^= 0x01;
    const ok = await verifyBytes(new Uint8Array(0), tampered, publicKey);
    expect(ok).toBe(false);
  });
});

describe("keygen / PEM material round-trip", () => {
  it("signs and verifies through exported-and-reimported raw/pkcs8/spki key material", async () => {
    const keyPair = await generateEd25519KeyPair();
    const privatePkcs8 = await exportEd25519PrivateKeyPkcs8(keyPair.privateKey);
    const publicSpki = await exportEd25519PublicKeySpki(keyPair.publicKey);
    const publicRaw = await exportEd25519PublicKeyRaw(keyPair.publicKey);

    const reimportedPrivate = await importEd25519PrivateKeyPkcs8(privatePkcs8);
    const reimportedPublicSpki = await importEd25519PublicKeySpki(publicSpki);
    const reimportedPublicRaw = await importEd25519PublicKeyRaw(publicRaw);

    const message = encoder.encode("evidence pack round-trip");
    const signature = await signBytes(message, reimportedPrivate);
    expect(await verifyBytes(message, signature, reimportedPublicSpki)).toBe(true);
    expect(await verifyBytes(message, signature, reimportedPublicRaw)).toBe(true);
  });

  it("derives a stable 16-hex-character keyId from the raw public key", async () => {
    const keyPair = await generateEd25519KeyPair();
    const publicRaw = await exportEd25519PublicKeyRaw(keyPair.publicKey);
    const keyId = await deriveEd25519KeyId(publicRaw);
    expect(keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(await deriveEd25519KeyId(publicRaw)).toBe(keyId); // deterministic
  });
});

function emptySource(): EvidenceSource {
  return {
    async listLineage() {
      return [];
    },
    async pageLineage() {
      return { events: [] };
    },
    async listPromotionStates() {
      return [];
    },
    async listFixations() {
      return [];
    },
  };
}

/** An in-memory EvidencePackReader over a BuiltEvidencePack, for verifyEvidencePack tests that don't
 * need a real filesystem. */
function memoryReader(
  files: readonly { path: string; content: Uint8Array }[],
  manifestJson: string,
  signatureBase64: string,
): EvidencePackReader {
  return {
    async readManifest() {
      return encoder.encode(manifestJson);
    },
    async readSignature() {
      return encoder.encode(signatureBase64);
    },
    async readFile(path) {
      const file = files.find((f) => f.path === path);
      if (file == null) throw new Error(`no such file in pack: ${path}`);
      return file.content;
    },
    async listFiles() {
      return ["manifest.json", "manifest.sig", ...files.map((f) => f.path)];
    },
  };
}

describe("signManifest / verifyEvidencePack", () => {
  async function buildSignedPack() {
    const keyPair = await generateEd25519KeyPair();
    const publicRaw = await exportEd25519PublicKeyRaw(keyPair.publicKey);
    const keyId = await deriveEd25519KeyId(publicRaw);

    const pack = await buildEvidencePack({
      source: emptySource(),
      scope: { since: "2026-01-01T00:00:00.000Z", until: "2026-01-31T23:59:59.999Z" },
      generator: "test-generator/1",
      signer: { alg: "Ed25519", keyId },
      now: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    const signatureBase64 = await signManifest(pack.manifest, keyPair.privateKey);
    const manifestJson = JSON.stringify(pack.manifest);
    return { pack, manifestJson, signatureBase64, publicKey: keyPair.publicKey };
  }

  it("verifies a freshly built and signed pack", async () => {
    const { pack, manifestJson, signatureBase64, publicKey } = await buildSignedPack();
    const result = await verifyEvidencePack(
      memoryReader(pack.files, manifestJson, signatureBase64),
      publicKey,
    );
    expect(result.errors).toEqual([]);
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("also verifies manifest signature directly (verifyManifestSignature)", async () => {
    const { pack, signatureBase64, publicKey } = await buildSignedPack();
    expect(await verifyManifestSignature(pack.manifest, signatureBase64, publicKey)).toBe(true);
  });

  it("fails when the wrong public key is used", async () => {
    const { pack, manifestJson, signatureBase64 } = await buildSignedPack();
    const otherKeyPair = await generateEd25519KeyPair();
    const result = await verifyEvidencePack(
      memoryReader(pack.files, manifestJson, signatureBase64),
      otherKeyPair.publicKey,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("manifest.sig"))).toBe(true);
  });

  it("reads no other file at all once the signature fails to verify (fails closed)", async () => {
    const { pack, manifestJson, signatureBase64 } = await buildSignedPack();
    const otherKeyPair = await generateEd25519KeyPair();
    const readFileCalls: string[] = [];
    let listFilesCalls = 0;
    const spyReader: EvidencePackReader = {
      async readManifest() {
        return encoder.encode(manifestJson);
      },
      async readSignature() {
        return encoder.encode(signatureBase64);
      },
      async readFile(path) {
        readFileCalls.push(path);
        const file = pack.files.find((f) => f.path === path);
        if (file == null) throw new Error(`no such file in pack: ${path}`);
        return file.content;
      },
      async listFiles() {
        listFilesCalls++;
        return ["manifest.json", "manifest.sig", ...pack.files.map((f) => f.path)];
      },
    };
    const result = await verifyEvidencePack(spyReader, otherKeyPair.publicKey);
    expect(result.ok).toBe(false);
    expect(readFileCalls).toEqual([]);
    expect(listFilesCalls).toBe(0);
  });

  it("fails when the pack directory contains a file the manifest does not list", async () => {
    const { pack, manifestJson, signatureBase64, publicKey } = await buildSignedPack();
    const reader: EvidencePackReader = {
      async readManifest() {
        return encoder.encode(manifestJson);
      },
      async readSignature() {
        return encoder.encode(signatureBase64);
      },
      async readFile(path) {
        const file = pack.files.find((f) => f.path === path);
        if (file == null) throw new Error(`no such file in pack: ${path}`);
        return file.content;
      },
      async listFiles() {
        // A file smuggled into the pack directory after signing, at an otherwise-valid-looking path.
        return [
          "manifest.json",
          "manifest.sig",
          ...pack.files.map((f) => f.path),
          `artifacts/${"b".repeat(64)}.html`,
        ];
      },
    };
    const result = await verifyEvidencePack(reader, publicKey);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("unexpected file") && e.includes("b".repeat(64)))).toBe(true);
  });

  it("refuses to read a files[] entry whose manifest-recorded size exceeds the hard cap, without ever calling readFile", async () => {
    const keyPair = await generateEd25519KeyPair();
    const publicRaw = await exportEd25519PublicKeyRaw(keyPair.publicKey);
    const keyId = await deriveEd25519KeyId(publicRaw);
    const pack = await buildEvidencePack({
      source: emptySource(),
      scope: { since: "2026-01-01T00:00:00.000Z", until: "2026-01-31T23:59:59.999Z" },
      generator: "test-generator/1",
      signer: { alg: "Ed25519", keyId },
      now: () => new Date("2026-02-01T00:00:00.000Z"),
    });
    const entry = pack.manifest.files.find((f) => f.path === "events.jsonl");
    if (entry == null) throw new Error("test fixture assumption broken: events.jsonl entry missing");
    // A manifest that (rightly signed or not) declares an implausible size for a file -- verify must
    // refuse before ever reading it, not after buffering ~100MiB into memory to find out.
    entry.bytes = 100 * 1024 * 1024;
    const signatureBase64 = await signManifest(pack.manifest, keyPair.privateKey);
    const manifestJson = JSON.stringify(pack.manifest);

    const readFileCalls: string[] = [];
    const reader: EvidencePackReader = {
      async readManifest() {
        return encoder.encode(manifestJson);
      },
      async readSignature() {
        return encoder.encode(signatureBase64);
      },
      async readFile(path) {
        readFileCalls.push(path);
        const file = pack.files.find((f) => f.path === path);
        if (file == null) throw new Error(`no such file in pack: ${path}`);
        return file.content;
      },
      async listFiles() {
        return ["manifest.json", "manifest.sig", ...pack.files.map((f) => f.path)];
      },
    };
    const result = await verifyEvidencePack(reader, keyPair.publicKey);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("events.jsonl") && e.includes("cap"))).toBe(true);
    // The oversized entry itself is never read (the other, untouched entries still are -- only this
    // one file's declared size was implausible).
    expect(readFileCalls.includes("events.jsonl")).toBe(false);
  });

  it("refuses to read a files[] entry whose on-disk size (via reader.size) differs from the manifest's recorded bytes, without reading it", async () => {
    const { pack, manifestJson, signatureBase64, publicKey } = await buildSignedPack();
    const targetPath = "events.jsonl";
    const readFileCalls: string[] = [];
    const reader: EvidencePackReader = {
      async readManifest() {
        return encoder.encode(manifestJson);
      },
      async readSignature() {
        return encoder.encode(signatureBase64);
      },
      async readFile(path) {
        readFileCalls.push(path);
        const file = pack.files.find((f) => f.path === path);
        if (file == null) throw new Error(`no such file in pack: ${path}`);
        return file.content;
      },
      async listFiles() {
        return ["manifest.json", "manifest.sig", ...pack.files.map((f) => f.path)];
      },
      // Simulates a file swapped on disk for something far larger than the (0-byte, empty-scope)
      // manifest ever recorded for it -- verify must catch this from the stat alone, without reading.
      async size(path) {
        return path === targetPath ? 10 * 1024 * 1024 : 0;
      },
    };
    const result = await verifyEvidencePack(reader, publicKey);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes(targetPath) && e.includes("on disk"))).toBe(true);
    expect(readFileCalls.includes(targetPath)).toBe(false);
  });

  it("fails when a single byte of the (always non-empty) manifest is tampered with after signing", async () => {
    // This fixture's scope has no events/promotions/fixations/artifacts, so every jsonl file is 0
    // bytes; the manifest itself is the one pack file guaranteed non-empty, so it stands in for "any
    // byte of the signed pack" here. The next test tampers a jsonl file's bytes instead.
    const { manifestJson, signatureBase64, publicKey } = await buildSignedPack();
    const tamperedManifestJson = manifestJson.replace('"complete":true', '"complete":false');
    const result = await verifyEvidencePack(
      memoryReader([], tamperedManifestJson, signatureBase64),
      publicKey,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("manifest.sig"))).toBe(true);
  });

  it("fails when a file's bytes no longer match the manifest's recorded hash, even with a valid manifest signature", async () => {
    const html = "<div>tamper target</div>";
    const source: EvidenceSource = {
      async listLineage() {
        return [];
      },
      async pageLineage() {
        return {
          events: [
            {
              id: "1",
              ts: "2026-01-05T00:00:00.000Z",
              actor: { kind: "system" },
              type: "component.generated",
              payload: { artifactId: "a1", html, artifactSha256: "placeholder" },
            },
          ],
        };
      },
      async listPromotionStates() {
        return [];
      },
      async listFixations() {
        return [];
      },
    };
    const keyPair = await generateEd25519KeyPair();
    const publicRaw = await exportEd25519PublicKeyRaw(keyPair.publicKey);
    const keyId = await deriveEd25519KeyId(publicRaw);
    const pack = await buildEvidencePack({
      source,
      scope: { since: "2026-01-01T00:00:00.000Z", until: "2026-01-31T23:59:59.999Z" },
      generator: "test-generator/1",
      signer: { alg: "Ed25519", keyId },
    });
    const signatureBase64 = await signManifest(pack.manifest, keyPair.privateKey);
    const manifestJson = JSON.stringify(pack.manifest);

    // Flip one byte in the events.jsonl content on disk, *after* signing -- the manifest (and its
    // signature) is unchanged, but the file no longer matches manifest.files[].sha256/bytes.
    const tamperedFiles = pack.files.map((f) => {
      if (f.path !== "events.jsonl") return f;
      const content = new Uint8Array(f.content);
      content[0] = content[0]! ^ 0xff;
      return { path: f.path, content };
    });

    const result = await verifyEvidencePack(
      memoryReader(tamperedFiles, manifestJson, signatureBase64),
      keyPair.publicKey,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("events.jsonl") && e.includes("sha256"))).toBe(true);
  });

  it("reports an artifactSha256/html mismatch as a non-fatal 'mismatches' entry, not a failure", async () => {
    const html = "<div>hello</div>";
    const source: EvidenceSource = {
      async listLineage() {
        return [];
      },
      async pageLineage() {
        return {
          events: [
            {
              id: "1",
              ts: "2026-01-05T00:00:00.000Z",
              actor: { kind: "system" },
              type: "component.generated",
              payload: { artifactId: "a1", html, artifactSha256: "not-the-real-hash" },
            },
          ],
        };
      },
      async listPromotionStates() {
        return [];
      },
      async listFixations() {
        return [];
      },
    };
    const keyPair = await generateEd25519KeyPair();
    const publicRaw = await exportEd25519PublicKeyRaw(keyPair.publicKey);
    const keyId = await deriveEd25519KeyId(publicRaw);
    const pack = await buildEvidencePack({
      source,
      scope: { since: "2026-01-01T00:00:00.000Z", until: "2026-01-31T23:59:59.999Z" },
      generator: "test-generator/1",
      signer: { alg: "Ed25519", keyId },
    });
    const signatureBase64 = await signManifest(pack.manifest, keyPair.privateKey);
    const manifestJson = JSON.stringify(pack.manifest);

    const result = await verifyEvidencePack(
      memoryReader(pack.files, manifestJson, signatureBase64),
      keyPair.publicKey,
    );
    expect(result.ok).toBe(true);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toContain("a1");
  });

  // The signature covers the raw manifest.json value: a lax schema parse (zod strips unknown keys)
  // must not let unsigned content ride along under a valid signature.
  describe("tampering with manifest.json content the schema would otherwise ignore or coerce", () => {
    async function verifyWithManifest(mutate: (manifest: Record<string, unknown>) => void) {
      const { pack, manifestJson, signatureBase64, publicKey } = await buildSignedPack();
      const manifest = JSON.parse(manifestJson) as Record<string, unknown>;
      mutate(manifest);
      return verifyEvidencePack(
        memoryReader(pack.files, JSON.stringify(manifest), signatureBase64),
        publicKey,
      );
    }

    it("fails on an unknown top-level key", async () => {
      const result = await verifyWithManifest((m) => {
        m.injected = "approved by legal";
      });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("manifest.sig"))).toBe(true);
    });

    it("fails on an unknown key nested inside scope", async () => {
      const result = await verifyWithManifest((m) => {
        (m.scope as Record<string, unknown>).approvedBy = "legal";
      });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("manifest.sig"))).toBe(true);
    });

    it("fails when a key is removed", async () => {
      const result = await verifyWithManifest((m) => {
        delete m.warnings;
      });
      expect(result.ok).toBe(false);
    });

    it("fails when a value is retyped (a number replaced by a numeric string)", async () => {
      const result = await verifyWithManifest((m) => {
        const counts = m.counts as Record<string, unknown>;
        counts.events = String(counts.events);
      });
      expect(result.ok).toBe(false);
    });

    it("rejects a validly signed manifest that carries an unknown key, on shape", async () => {
      const keyPair = await generateEd25519KeyPair();
      const keyId = await deriveEd25519KeyId(await exportEd25519PublicKeyRaw(keyPair.publicKey));
      const pack = await buildEvidencePack({
        source: emptySource(),
        scope: { since: "2026-01-01T00:00:00.000Z", until: "2026-01-31T23:59:59.999Z" },
        generator: "test-generator/1",
        signer: { alg: "Ed25519", keyId },
      });
      const withExtra = { ...pack.manifest, injected: "x" } as unknown as EvidenceManifest;
      const signatureBase64 = await signManifest(withExtra, keyPair.privateKey);
      const result = await verifyEvidencePack(
        memoryReader(pack.files, JSON.stringify(withExtra), signatureBase64),
        keyPair.publicKey,
      );
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("EvidenceManifestSchema");
    });

    it("treats a malformed (non-base64) signature as a failed verification, not a throw", async () => {
      const { pack, manifestJson, publicKey } = await buildSignedPack();
      const result = await verifyEvidencePack(
        memoryReader(pack.files, manifestJson, "!!!not base64!!!"),
        publicKey,
      );
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("manifest.sig"))).toBe(true);
    });
  });

  it("reports an unparseable line inside correctly hashed, signed jsonl content", async () => {
    const { pack, keyPair } = await (async () => {
      const keyPair = await generateEd25519KeyPair();
      const keyId = await deriveEd25519KeyId(await exportEd25519PublicKeyRaw(keyPair.publicKey));
      const pack = await buildEvidencePack({
        source: emptySource(),
        scope: { since: "2026-01-01T00:00:00.000Z", until: "2026-01-31T23:59:59.999Z" },
        generator: "test-generator/1",
        signer: { alg: "Ed25519", keyId },
      });
      return { pack, keyPair };
    })();
    // The exporter signed a file whose second line is not JSON: the hash matches, so only the content
    // scan can notice it.
    const content = encoder.encode('{"ok":true}\nnot json at all\n');
    const files = pack.files.map((f) => (f.path === "events.jsonl" ? { path: f.path, content } : f));
    const entry = pack.manifest.files.find((f) => f.path === "events.jsonl")!;
    entry.sha256 = await sha256HexBytes(content);
    entry.bytes = content.byteLength;
    const signatureBase64 = await signManifest(pack.manifest, keyPair.privateKey);
    const result = await verifyEvidencePack(
      memoryReader(files, JSON.stringify(pack.manifest), signatureBase64),
      keyPair.publicKey,
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.stringMatching(/events\.jsonl: unparseable JSON on line\(s\) 2\b/),
    ]);
  });

  it("fails cleanly on a manifest that is not valid JSON", async () => {
    const keyPair = await generateEd25519KeyPair();
    const reader: EvidencePackReader = {
      async readManifest() {
        return encoder.encode("{not json");
      },
      async readSignature() {
        return encoder.encode("");
      },
      async readFile() {
        throw new Error("not reached");
      },
      async listFiles() {
        throw new Error("not reached");
      },
    };
    const result = await verifyEvidencePack(reader, keyPair.publicKey);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("not valid JSON");
  });
});
