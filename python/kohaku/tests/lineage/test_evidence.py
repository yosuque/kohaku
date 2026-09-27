"""Tests for the Compliance Evidence Pack (pytest port of packages/lineage/test/evidence-{build,sign}.test.ts).

Storage is a tmp_path FileStoragePort (repository convention; see _helpers.py's module docstring).
Ed25519 tests need the `evidence` optional extra (`uv sync --extra evidence` at the workspace root) --
skipped automatically when `cryptography` is not installed, the same guard the module itself uses.
"""

from __future__ import annotations

import asyncio
import base64
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from kohaku.lineage import (
    EvidenceFileEntry,
    EvidenceManifestSigner,
    EvidencePackFile,
    EvidencePackScope,
    build_evidence_pack,
    create_storage_evidence_source,
    derive_ed25519_key_id,
    export_ed25519_public_key_raw,
    generate_ed25519_keypair,
    import_ed25519_private_key_pkcs8,
    import_ed25519_public_key_raw,
    is_safe_evidence_file_path,
    sign_bytes,
    sign_manifest,
    verify_bytes,
    verify_evidence_pack,
    verify_manifest_signature,
)
from kohaku.spec import LineageActor, PromotionState, sha256_hex
from kohaku.storage import FileStoragePort

from ._helpers import seed

pytest.importorskip("cryptography", reason="the `evidence` optional extra is not installed")

# Wide enough to cover _helpers.seed()'s fixed seed epoch (2026-07-17, see _helpers.py's _SEED_EPOCH).
_SCOPE = EvidencePackScope(since="2026-01-01T00:00:00.000Z", until="2026-12-31T23:59:59.999Z")
_SIGNER = EvidenceManifestSigner(keyId="0123456789abcdef")

ED25519_PKCS8_PREFIX = bytes.fromhex("302e020100300506032b657004220420")

# RFC 8032 Section 7.1, TEST 1 -- the canonical Ed25519 test vector (empty message). Independently
# cross-checked against the TS test's own re-derivation (packages/lineage/test/evidence-sign.test.ts):
# importing this secret key seed and signing the empty message reproduces SIGNATURE exactly.
RFC8032_TEST1_SECRET_KEY_SEED = bytes.fromhex(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
)
RFC8032_TEST1_PUBLIC_KEY = bytes.fromhex(
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
)
RFC8032_TEST1_SIGNATURE = bytes.fromhex(
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46"
    "bd25bf5f0595bbe24655141438e7a100b"
)


def test_rfc8032_test1_verifies() -> None:
    public_key = import_ed25519_public_key_raw(RFC8032_TEST1_PUBLIC_KEY)
    assert verify_bytes(b"", RFC8032_TEST1_SIGNATURE, public_key) is True


def test_rfc8032_test1_reproduces_signature_from_the_secret_key() -> None:
    private_key = import_ed25519_private_key_pkcs8(
        ED25519_PKCS8_PREFIX + RFC8032_TEST1_SECRET_KEY_SEED
    )
    signature = sign_bytes(b"", private_key)
    assert signature == RFC8032_TEST1_SIGNATURE


def test_rfc8032_test1_fails_on_a_single_flipped_byte() -> None:
    public_key = import_ed25519_public_key_raw(RFC8032_TEST1_PUBLIC_KEY)
    tampered = bytearray(RFC8032_TEST1_SIGNATURE)
    tampered[0] ^= 0x01
    assert verify_bytes(b"", bytes(tampered), public_key) is False


def test_keygen_roundtrip() -> None:
    keypair = generate_ed25519_keypair()
    public_raw = export_ed25519_public_key_raw(keypair.public_key)
    key_id = derive_ed25519_key_id(public_raw)
    assert len(key_id) == 16
    message = b"evidence pack round-trip"
    signature = sign_bytes(message, keypair.private_key)
    assert verify_bytes(message, signature, keypair.public_key) is True


# Python's `$` (without re.MULTILINE) matches immediately before a trailing "\n" at the end of the
# string, unlike JS's `$` (no `m` flag), which anchors strictly to the end -- so `.match()` against a
# `^...$`-anchored pattern let e.g. "events.jsonl\n" through as if it were "events.jsonl". Fixed by
# switching every such check in evidence.py to `.fullmatch()`; these lock the fix in.
def test_is_safe_evidence_file_path_rejects_a_trailing_newline() -> None:
    assert is_safe_evidence_file_path("events.jsonl\n") is False
    assert is_safe_evidence_file_path(f"artifacts/{'a' * 64}.html\n") is False


def test_evidence_file_entry_rejects_a_path_with_a_trailing_newline() -> None:
    with pytest.raises(ValidationError):
        EvidenceFileEntry(path="events.jsonl\n", sha256="a" * 64, bytes=10)


def test_evidence_file_entry_rejects_a_sha256_with_a_trailing_newline() -> None:
    with pytest.raises(ValidationError):
        EvidenceFileEntry(path="events.jsonl", sha256=f"{'a' * 64}\n", bytes=10)


def test_evidence_manifest_signer_rejects_a_key_id_with_a_trailing_newline() -> None:
    with pytest.raises(ValidationError):
        EvidenceManifestSigner(keyId="0123456789abcdef\n")


class _MemoryReader:
    """An in-memory EvidencePackReader over a list of EvidencePackFile, for verify tests that don't
    need a real filesystem."""

    def __init__(
        self, files: list[EvidencePackFile], manifest_json: str, signature_base64: str
    ) -> None:
        self._files = files
        self._manifest_json = manifest_json.encode("utf-8")
        self._signature = signature_base64.encode("utf-8")

    async def read_manifest(self) -> bytes:
        return self._manifest_json

    async def read_signature(self) -> bytes:
        return self._signature

    async def read_file(self, path: str) -> bytes:
        for f in self._files:
            if f.path == path:
                return f.content
        raise FileNotFoundError(path)

    async def list_files(self) -> list[str]:
        return ["manifest.json", "manifest.sig", *(f.path for f in self._files)]


def test_build_evidence_pack_and_verify_roundtrip(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        html = "<div>hello</div>"
        real_sha = sha256_hex(html)
        await seed(
            storage,
            "component.generated",
            {"artifactId": "a1", "artifactSha256": real_sha, "html": html},
            actor=LineageActor(kind="model"),
        )
        await seed(storage, "component.reviewed", {"artifactId": "a1", "decision": "approve"})
        await seed(storage, "intent.fixated", {"intentHash": "h1"})
        # intent.migrated (F7's catalog migration, design.md #65) is a real LineageEventType member.
        await seed(storage, "intent.migrated", {"intentHash": "h1"})
        await storage.put_promotion_state(
            PromotionState(
                artifactId="a1", status="published", updatedAt="2026-07-17T00:00:00Z", data={}
            )
        )

        keypair = generate_ed25519_keypair()
        key_id = derive_ed25519_key_id(export_ed25519_public_key_raw(keypair.public_key))
        pack = await build_evidence_pack(
            source=create_storage_evidence_source(storage),
            scope=_SCOPE,
            generator="pytest/1",
            signer=EvidenceManifestSigner(keyId=key_id),
        )

        assert pack.manifest.complete is True
        assert pack.manifest.counts.events == 4
        assert pack.manifest.counts.approvals == 3
        assert pack.manifest.counts.promotions == 1
        assert pack.manifest.counts.artifacts == 1
        assert pack.manifest.warnings == []

        signature = sign_manifest(pack.manifest, keypair.private_key)
        assert verify_manifest_signature(pack.manifest, signature, keypair.public_key) is True

        manifest_json = pack.manifest.model_dump_json()
        reader = _MemoryReader(pack.files, manifest_json, signature)
        result = await verify_evidence_pack(reader, keypair.public_key)
        assert result.errors == []
        assert result.mismatches == []
        assert result.ok is True

    asyncio.run(run())


def test_build_evidence_pack_records_artifact_hash_mismatch_as_warning(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await seed(
            storage,
            "component.generated",
            {"artifactId": "a1", "artifactSha256": "not-the-real-hash", "html": "<div>hi</div>"},
        )
        pack = await build_evidence_pack(
            source=create_storage_evidence_source(storage),
            scope=_SCOPE,
            generator="pytest/1",
            signer=_SIGNER,
        )
        assert len(pack.manifest.warnings) == 1
        assert "a1" in pack.manifest.warnings[0]
        assert pack.manifest.counts.artifacts == 1

    asyncio.run(run())


def test_build_evidence_pack_requires_allow_incomplete_without_page_lineage(tmp_path: Path) -> None:
    class _NoPageLineageSource:
        async def list_lineage(self, filter: Any = None) -> list[Any]:
            return []

        async def list_promotion_states(self, tenant: str | None = None) -> list[Any]:
            return []

        async def list_fixations(self, tenant: str | None = None) -> list[Any]:
            return []

    async def run() -> None:
        with pytest.raises(ValueError, match="page_lineage"):
            await build_evidence_pack(
                source=_NoPageLineageSource(),
                scope=_SCOPE,
                generator="pytest/1",
                signer=_SIGNER,
            )
        pack = await build_evidence_pack(
            source=_NoPageLineageSource(),
            scope=_SCOPE,
            generator="pytest/1",
            signer=_SIGNER,
            allow_incomplete=True,
        )
        assert pack.manifest.complete is False

    asyncio.run(run())


def test_verify_fails_when_a_pack_file_byte_is_tampered_with(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await seed(storage, "view.composed", {"tier": "L1"})
        keypair = generate_ed25519_keypair()
        key_id = derive_ed25519_key_id(export_ed25519_public_key_raw(keypair.public_key))
        pack = await build_evidence_pack(
            source=create_storage_evidence_source(storage),
            scope=_SCOPE,
            generator="pytest/1",
            signer=EvidenceManifestSigner(keyId=key_id),
        )
        signature = sign_manifest(pack.manifest, keypair.private_key)
        manifest_json = pack.manifest.model_dump_json()

        tampered_files = []
        for f in pack.files:
            if f.path == "events.jsonl":
                content = bytearray(f.content)
                content[0] ^= 0xFF
                tampered_files.append(EvidencePackFile(path=f.path, content=bytes(content)))
            else:
                tampered_files.append(f)

        reader = _MemoryReader(tampered_files, manifest_json, signature)
        result = await verify_evidence_pack(reader, keypair.public_key)
        assert result.ok is False
        assert any("events.jsonl" in e and "sha256" in e for e in result.errors)

    asyncio.run(run())


def test_verify_refuses_a_files_entry_whose_manifest_recorded_size_exceeds_the_hard_cap(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await seed(storage, "view.composed", {"tier": "L1"})
        keypair = generate_ed25519_keypair()
        key_id = derive_ed25519_key_id(export_ed25519_public_key_raw(keypair.public_key))
        pack = await build_evidence_pack(
            source=create_storage_evidence_source(storage),
            scope=_SCOPE,
            generator="pytest/1",
            signer=EvidenceManifestSigner(keyId=key_id),
        )
        entry = next(f for f in pack.manifest.files if f.path == "events.jsonl")
        # A manifest that (rightly signed or not) declares an implausible size for a file -- verify must
        # refuse before ever reading it, not after buffering ~100MiB into memory to find out.
        entry.bytes = 100 * 1024 * 1024
        signature = sign_manifest(pack.manifest, keypair.private_key)
        manifest_json = pack.manifest.model_dump_json()

        read_file_calls: list[str] = []

        class _SpyReader:
            async def read_manifest(self) -> bytes:
                return manifest_json.encode("utf-8")

            async def read_signature(self) -> bytes:
                return signature.encode("utf-8")

            async def read_file(self, path: str) -> bytes:
                read_file_calls.append(path)
                for f in pack.files:
                    if f.path == path:
                        return f.content
                raise FileNotFoundError(path)

            async def list_files(self) -> list[str]:
                return ["manifest.json", "manifest.sig", *(f.path for f in pack.files)]

        result = await verify_evidence_pack(_SpyReader(), keypair.public_key)
        assert result.ok is False
        assert any("events.jsonl" in e and "cap" in e for e in result.errors)
        # The oversized entry itself is never read (the other, untouched entries still are).
        assert "events.jsonl" not in read_file_calls

    asyncio.run(run())


def test_verify_refuses_a_files_entry_whose_on_disk_size_differs_via_size(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await seed(storage, "view.composed", {"tier": "L1"})
        keypair = generate_ed25519_keypair()
        key_id = derive_ed25519_key_id(export_ed25519_public_key_raw(keypair.public_key))
        pack = await build_evidence_pack(
            source=create_storage_evidence_source(storage),
            scope=_SCOPE,
            generator="pytest/1",
            signer=EvidenceManifestSigner(keyId=key_id),
        )
        signature = sign_manifest(pack.manifest, keypair.private_key)
        manifest_json = pack.manifest.model_dump_json()
        target_path = "events.jsonl"
        read_file_calls: list[str] = []

        class _SpyReader:
            async def read_manifest(self) -> bytes:
                return manifest_json.encode("utf-8")

            async def read_signature(self) -> bytes:
                return signature.encode("utf-8")

            async def read_file(self, path: str) -> bytes:
                read_file_calls.append(path)
                for f in pack.files:
                    if f.path == path:
                        return f.content
                raise FileNotFoundError(path)

            async def list_files(self) -> list[str]:
                return ["manifest.json", "manifest.sig", *(f.path for f in pack.files)]

            async def size(self, path: str) -> int:
                # Simulates a file swapped on disk for something far larger than the manifest recorded.
                return 10 * 1024 * 1024 if path == target_path else 0

        result = await verify_evidence_pack(_SpyReader(), keypair.public_key)
        assert result.ok is False
        assert any(target_path in e and "on disk" in e for e in result.errors)
        assert target_path not in read_file_calls

    asyncio.run(run())


def test_verify_fails_with_the_wrong_public_key(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await seed(storage, "view.composed", {"tier": "L1"})
        keypair = generate_ed25519_keypair()
        other_keypair = generate_ed25519_keypair()
        key_id = derive_ed25519_key_id(export_ed25519_public_key_raw(keypair.public_key))
        pack = await build_evidence_pack(
            source=create_storage_evidence_source(storage),
            scope=_SCOPE,
            generator="pytest/1",
            signer=EvidenceManifestSigner(keyId=key_id),
        )
        signature = sign_manifest(pack.manifest, keypair.private_key)
        manifest_json = pack.manifest.model_dump_json()
        reader = _MemoryReader(pack.files, manifest_json, signature)
        result = await verify_evidence_pack(reader, other_keypair.public_key)
        assert result.ok is False
        assert any("manifest.sig" in e for e in result.errors)

    asyncio.run(run())


def test_verify_reports_artifact_mismatch_as_non_fatal(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        html = "<div>hello</div>"
        await seed(
            storage,
            "component.generated",
            {"artifactId": "a1", "artifactSha256": "not-the-real-hash", "html": html},
        )
        keypair = generate_ed25519_keypair()
        key_id = derive_ed25519_key_id(export_ed25519_public_key_raw(keypair.public_key))
        pack = await build_evidence_pack(
            source=create_storage_evidence_source(storage),
            scope=_SCOPE,
            generator="pytest/1",
            signer=EvidenceManifestSigner(keyId=key_id),
        )
        signature = sign_manifest(pack.manifest, keypair.private_key)
        manifest_json = pack.manifest.model_dump_json()
        reader = _MemoryReader(pack.files, manifest_json, signature)
        result = await verify_evidence_pack(reader, keypair.public_key)
        assert result.ok is True
        assert len(result.mismatches) == 1
        assert "a1" in result.mismatches[0]

    asyncio.run(run())


def test_verify_fails_cleanly_on_invalid_manifest_json() -> None:
    async def run() -> None:
        keypair = generate_ed25519_keypair()

        class _BadReader:
            async def read_manifest(self) -> bytes:
                return b"{not json"

            async def read_signature(self) -> bytes:
                return b""

            async def read_file(self, path: str) -> bytes:
                raise AssertionError("not reached")

            async def list_files(self) -> list[str]:
                raise AssertionError("not reached")

        result = await verify_evidence_pack(_BadReader(), keypair.public_key)
        assert result.ok is False
        assert "not valid JSON" in result.errors[0]

    asyncio.run(run())


def test_signature_is_base64_text() -> None:
    keypair = generate_ed25519_keypair()
    from kohaku.lineage import EvidenceManifest, EvidenceManifestCounts, EvidenceManifestScope

    manifest = EvidenceManifest(
        generator="pytest/1",
        generatedAt="2026-02-01T00:00:00.000Z",
        scope=EvidenceManifestScope(
            since="2026-01-01T00:00:00.000Z", until="2026-01-31T23:59:59.999Z"
        ),
        counts=EvidenceManifestCounts(
            events=0, approvals=0, promotions=0, fixations=0, artifacts=0
        ),
        complete=True,
        files=[],
        warnings=[],
        signer=_SIGNER,
    )
    signature = sign_manifest(manifest, keypair.private_key)
    # round-trips through base64 cleanly
    assert base64.b64encode(base64.b64decode(signature)).decode("ascii") == signature
