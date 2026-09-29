"""Compliance Evidence Pack (design.md #67).

Port of the TS reference implementation's `packages/lineage/src/evidence/{manifest,source,build,sign,
artifacts}.ts`. TS keeps those as five separate files; this port deliberately keeps everything in one
module (an explicit, brief-specified exception to docs/runbooks/python-mirror.md's usual "one TS file
= one Python module" layout rule, not an oversight).

A pack is a directory of normalized, append-only exports (events.jsonl / approvals.jsonl /
promotions.jsonl / fixations.jsonl / artifacts/<sha256>.html) plus a manifest.json and a detached
Ed25519 signature (manifest.sig). The manifest schema is intentionally not part of the wire contract
(not mirrored into spec/schemas) -- it describes an export format for auditors, not something a host
and a renderer negotiate.

Ed25519 signing/verification needs the `cryptography` package (the optional `evidence` extra:
`pip install 'kohaku-ui[evidence]'`). Every function that actually touches key material imports it
lazily and raises a clear `ImportError` when it is missing, the same lazy-import-and-guard convention
`kohaku.llm.adapters.anthropic_native` uses for the `anthropic` SDK. Building and reading a pack's
plain data (manifest / jsonl assembly, schema validation) needs no such dependency.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Final, Literal, Protocol, cast

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from kohaku.spec import (
    MAX_LINEAGE_PAGE_SIZE,
    FixationRecord,
    FixationRecordModel,
    LineageEventRecord,
    LineageEventRecordModel,
    LineageFilter,
    LineagePageRequest,
    PromotionState,
    PromotionStateModel,
    StoragePort,
    canonical_stringify,
    sha256_hex,
)

from .events import Clock, LineageEventType, now_iso

if TYPE_CHECKING:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PrivateKey,
        Ed25519PublicKey,
    )
else:
    Ed25519PrivateKey = Any
    Ed25519PublicKey = Any

# --- manifest.ts ---

EVIDENCE_PACK_FORMAT: Final = "kohaku-evidence-pack"
EVIDENCE_PACK_VERSION: Final = 1

# The largest single pack file build_evidence_pack will emit and verify_evidence_pack will read. One
# constant shared by both sides, so a pack that builds always verifies; an export whose window is too
# large fails at build time with a message to narrow it.
MAX_EVIDENCE_FILE_BYTES: Final = 64 * 1024 * 1024  # 64 MiB

_SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}$")
_KEY_ID_HEX_RE = re.compile(r"^[0-9a-f]{16}$")

# The only shapes manifest.files[].path may take: one of the four fixed jsonl filenames, or an artifact
# keyed by its own sha256. Deliberately closed (no wildcard subdirectories, no "..", no absolute path, no
# backslash) because this string ultimately drives a filesystem read (verify_evidence_pack / a caller's
# reader) over data from a manifest a verifier is, by definition, not yet sure it can trust.
EVIDENCE_FILE_PATH_PATTERN: Final = re.compile(
    r"^(?:events|approvals|promotions|fixations)\.jsonl$|^artifacts/[0-9a-f]{64}\.html$"
)


def is_safe_evidence_file_path(path: str) -> bool:
    """Structural re-check of EVIDENCE_FILE_PATH_PATTERN, for a caller (e.g. verify_evidence_pack) that
    wants to defend against a path reaching it some other way than through this schema.

    Uses fullmatch, not match: Python's `$` matches immediately before a trailing "\\n" (unlike JS's `$`,
    which anchors strictly to the end of the string with no `m` flag), so `.match()` against a
    `^...$`-anchored pattern would let e.g. "events.jsonl\\n" through as if it were "events.jsonl".
    """
    return EVIDENCE_FILE_PATH_PATTERN.fullmatch(path) is not None


def _find_json_null(value: Any, path: str = "$") -> str | None:
    """The path of the first JSON null inside `value`, or None. No manifest field is nullable, and TS's
    `.optional()` accepts an absent key but not an explicit null; the Python models' `X | None = None`
    fields cannot tell the two apart, so verify_evidence_pack rejects a null on the wire up front."""
    if value is None:
        return path
    if isinstance(value, dict):
        for k, v in value.items():
            found = _find_json_null(v, f"{path}.{k}")
            if found is not None:
                return found
    elif isinstance(value, list):
        for i, v in enumerate(value):
            found = _find_json_null(v, f"{path}[{i}]")
            if found is not None:
                return found
    return None


class _EvidenceModel(BaseModel):
    """Common config for the evidence-pack models: reject unknown keys and coercion, and give no
    required field a default -- the mirror of the TS schemas' `.strict()` (manifest.ts), so both
    languages accept exactly the same manifests. verify_evidence_pack checks the signature over the raw
    manifest.json value before validating it here; strictness keeps the *accepted set* identical, it is
    not what protects the signed bytes."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid", strict=True)


class EvidenceFileEntry(_EvidenceModel):
    """One file inside the pack, as recorded for integrity verification."""

    path: str = Field(min_length=1)
    sha256: str
    bytes: int = Field(ge=0)
    records: int | None = Field(default=None, ge=0)

    @field_validator("path")
    @classmethod
    def _check_path(cls, v: str) -> str:
        if not is_safe_evidence_file_path(v):
            raise ValueError("path must be a fixed jsonl filename or artifacts/<sha256>.html")
        return v

    @field_validator("sha256")
    @classmethod
    def _check_sha256(cls, v: str) -> str:
        # fullmatch, not match -- see is_safe_evidence_file_path's docstring for why.
        if not _SHA256_HEX_RE.fullmatch(v):
            raise ValueError("sha256 must be 64 lowercase hex characters")
        return v


class EvidenceManifestScope(_EvidenceModel):
    """The export's scope: a time window (mandatory) and an optional tenant restriction."""

    tenant: str | None = None
    since: str
    until: str


class EvidenceManifestCounts(_EvidenceModel):
    """Record counts per exported file, for an auditor's at-a-glance summary (see `files` for integrity)."""

    events: int = Field(ge=0)
    approvals: int = Field(ge=0)
    promotions: int = Field(ge=0)
    fixations: int = Field(ge=0)
    artifacts: int = Field(ge=0)


class EvidenceManifestSigner(_EvidenceModel):
    alg: Literal["Ed25519"]
    keyId: str

    @field_validator("keyId")
    @classmethod
    def _check_key_id(cls, v: str) -> str:
        # fullmatch, not match -- see is_safe_evidence_file_path's docstring for why.
        if not _KEY_ID_HEX_RE.fullmatch(v):
            raise ValueError("keyId must be 16 lowercase hex characters")
        return v


class EvidenceManifest(_EvidenceModel):
    format: Literal["kohaku-evidence-pack"]
    version: Literal[1]
    generator: str = Field(min_length=1)
    generatedAt: str
    scope: EvidenceManifestScope
    counts: EvidenceManifestCounts
    # False whenever the export is known not to be exhaustive over `scope`, for any reason -- not just a
    # StoragePort with no page_lineage (build_evidence_pack's own concern, gated by allow_incomplete),
    # but also a structural limitation of the source itself (e.g. a REST-sourced export whose
    # fixations.jsonl cannot be fully reconstructed; see the TS CLI's export.ts, which sets this
    # alongside the corresponding warnings entry -- there is no Python CLI equivalent). An auditor MUST
    # treat an incomplete pack as a partial record, not as proof of the absence of records outside it.
    complete: bool
    files: list[EvidenceFileEntry]
    warnings: list[str]
    signer: EvidenceManifestSigner

    def canonical_dict(self) -> dict[str, Any]:
        """The manifest as a plain JSON-able dict with unset optionals dropped (Python's model_dump
        would otherwise emit them as explicit `null`, unlike TS's `undefined`-drops-the-key behavior --
        see canonical_stringify's own cross-language note). This, not `model_dump()` directly, is what
        `sign_manifest` / `verify_manifest_signature` canonicalize and sign."""
        return self.model_dump(mode="json", exclude_none=True, by_alias=True)


# --- artifacts.ts ---


@dataclass(frozen=True)
class ArtifactClaim:
    """A component artifact's html body found in the lineage log or a promotion snapshot, alongside the
    hash the source itself claimed for it (if any)."""

    artifact_id: str
    html: str
    claimed_sha256: str | None = None


def artifact_claim_from_event_payload(type_: str, payload: dict[str, Any]) -> ArtifactClaim | None:
    """Extracts an ArtifactClaim from a `component.generated` lineage event's payload, if it carries html."""
    if type_ != "component.generated":
        return None
    artifact_id = payload.get("artifactId")
    html = payload.get("html")
    if not isinstance(artifact_id, str) or not isinstance(html, str) or html == "":
        return None
    claimed = payload.get("artifactSha256")
    return ArtifactClaim(
        artifact_id=artifact_id,
        html=html,
        claimed_sha256=claimed if isinstance(claimed, str) else None,
    )


def artifact_claim_from_promotion_data(
    artifact_id: str, data: dict[str, Any]
) -> ArtifactClaim | None:
    """Extracts an ArtifactClaim from a PromotionState's `data`, if it carries html -- populated once a
    candidate is published (candidate_store.py's self-contained published projection)."""
    html = data.get("html")
    if not isinstance(html, str) or html == "":
        return None
    claimed = data.get("sha256")
    return ArtifactClaim(
        artifact_id=artifact_id,
        html=html,
        claimed_sha256=claimed if isinstance(claimed, str) else None,
    )


# --- source.ts ---


class EvidenceSource(Protocol):
    """Read-only source `build_evidence_pack` reads from. A plain `StoragePort` already satisfies this
    structurally (Python duck typing), including its *optional* `page_lineage` method -- checked the
    same way the rest of this codebase checks it, with `hasattr`, since neither this Protocol nor
    `StoragePort` declares it as a member (see `kohaku.spec.ports.StoragePort`'s own comment on why)."""

    async def list_lineage(
        self, filter: LineageFilter | None = None
    ) -> list[LineageEventRecord]: ...

    async def list_promotion_states(self, tenant: str | None = None) -> list[PromotionState]: ...

    async def list_fixations(self, tenant: str | None = None) -> list[FixationRecord]: ...


def create_storage_evidence_source(storage: StoragePort) -> EvidenceSource:
    """Adapts a local StoragePort into an EvidenceSource. A StoragePort already satisfies EvidenceSource
    structurally; this identity function exists only for API parity with the TS reference
    implementation's explicit adapter (source.ts's `createStorageEvidenceSource`)."""
    return storage


# --- build.ts ---

# Typed as tuple[LineageEventType, ...] (not a bare str tuple) so a typo or a retired event type is
# caught by mypy; `intent.migrated` (design.md #65, F7's catalog migration) is a real member of that
# type.
EVIDENCE_APPROVAL_EVENT_TYPES: tuple[LineageEventType, ...] = (
    "component.reviewed",
    "component.published",
    "component.withdrawn",
    "intent.fixated",
    "intent.unfixated",
    "intent.migrated",
)


@dataclass(frozen=True)
class EvidencePackScope:
    since: str
    until: str
    tenant: str | None = None


@dataclass(frozen=True)
class EvidencePackFile:
    path: str
    content: bytes


@dataclass(frozen=True)
class BuiltEvidencePack:
    """The pack contents before signing (see `sign_manifest`, which turns this into manifest.sig)."""

    manifest: EvidenceManifest
    files: list[EvidencePackFile]


def _event_wire(event: LineageEventRecord) -> dict[str, Any]:
    # by_alias=True: pinnedSpec (via FixationRecordModel below) and any nested UISpec field can carry a
    # pydantic alias (e.g. DataRef.ref's alias "$ref") that model_dump would otherwise emit under the
    # Python attribute name instead of the wire key -- a real cross-language byte mismatch this event's
    # own payload doesn't happen to carry, but the three _*_wire helpers share this call shape on purpose.
    return LineageEventRecordModel.model_validate(event, from_attributes=True).model_dump(
        mode="json", exclude_none=True, by_alias=True
    )


def _promotion_wire(state: PromotionState) -> dict[str, Any]:
    return PromotionStateModel.model_validate(state, from_attributes=True).model_dump(
        mode="json", exclude_none=True, by_alias=True
    )


def _fixation_wire(record: FixationRecord) -> dict[str, Any]:
    # pinnedSpec is a full UISpec, whose data-binding nodes use aliased fields (DataRef.ref -> "$ref");
    # without by_alias=True those would serialize as "ref", a real cross-language byte mismatch caught by
    # spec/test/fixtures/evidence-pack/'s golden.
    return FixationRecordModel.model_validate(record, from_attributes=True).model_dump(
        mode="json", exclude_none=True, by_alias=True
    )


def _json_lines(records: list[dict[str, Any]]) -> str:
    if not records:
        return ""
    return "\n".join(canonical_stringify(r) for r in records) + "\n"


async def build_evidence_pack(
    *,
    source: EvidenceSource,
    scope: EvidencePackScope,
    generator: str,
    signer: EvidenceManifestSigner,
    allow_incomplete: bool = False,
    page_size: int | None = None,
    now: Clock = now_iso,
    max_file_bytes: int = MAX_EVIDENCE_FILE_BYTES,
) -> BuiltEvidencePack:
    """Assembles a Compliance Evidence Pack from an EvidenceSource -- normalized lineage events, an
    approvals index, promotion/fixation snapshots, and the referenced component HTML artifacts -- as an
    in-memory file set plus its (unsigned) manifest. Signing is a separate step (`sign_manifest`);
    writing the files to disk is the caller's responsibility.

    `max_file_bytes` is the largest single pack file to emit (default MAX_EVIDENCE_FILE_BYTES, the same cap
    verify_evidence_pack enforces, so a pack that builds always verifies); a file over it raises
    ValueError telling the caller to narrow the window. Lowered only by tests.
    """
    events: list[LineageEventRecord]
    complete: bool
    if hasattr(source, "page_lineage"):
        events = []
        cursor: str | None = None
        while True:
            page = await source.page_lineage(
                LineagePageRequest(
                    tenant=scope.tenant,
                    since=scope.since,
                    until=scope.until,
                    cursor=cursor,
                    pageSize=page_size,
                )
            )
            events.extend(page.events)
            if page.nextCursor is None:
                break
            cursor = page.nextCursor
        complete = True
    else:
        if not allow_incomplete:
            raise ValueError(
                "EvidenceSource has no page_lineage (the backing StoragePort does not implement it); "
                "pass allow_incomplete=True to fall back to a bounded list_lineage tail window instead "
                "of failing the export."
            )
        events = await source.list_lineage(
            LineageFilter(
                tenant=scope.tenant,
                since=scope.since,
                until=scope.until,
                limit=MAX_LINEAGE_PAGE_SIZE,
            )
        )
        complete = False

    approvals = [e for e in events if e.type in EVIDENCE_APPROVAL_EVENT_TYPES]
    promotions = await source.list_promotion_states(scope.tenant)
    fixations = await source.list_fixations(scope.tenant)

    warnings: list[str] = []
    # Keyed by the artifact's *actual* content hash, so the same html reached from two origins (e.g. a
    # component.generated event and its later published promotion state) is written once.
    artifacts_by_hash: dict[str, str] = {}

    def consider(claim: ArtifactClaim | None, origin: str) -> None:
        if claim is None:
            return
        actual_sha256 = sha256_hex(claim.html)
        if actual_sha256 not in artifacts_by_hash:
            artifacts_by_hash[actual_sha256] = claim.html
        if claim.claimed_sha256 is not None and claim.claimed_sha256 != actual_sha256:
            warnings.append(
                f"artifact {claim.artifact_id}: recorded sha256 {claim.claimed_sha256} does not match "
                f"sha256 of its own html ({actual_sha256}) [source: {origin}]"
            )

    for event in events:
        consider(
            artifact_claim_from_event_payload(event.type, event.payload), "component.generated"
        )
    for state in promotions:
        consider(
            artifact_claim_from_promotion_data(state.artifactId, state.data), "promotion state"
        )

    files: list[EvidencePackFile] = []
    file_entries: list[EvidenceFileEntry] = []

    def add_text_file(path: str, text: str, records: int | None = None) -> None:
        content = text.encode("utf-8")
        if len(content) > max_file_bytes:
            raise ValueError(
                f"{path} would be {len(content)} bytes, over the {max_file_bytes}-byte per-file cap "
                "that evidence verification enforces, so a pack containing it could not be verified; "
                "narrow the export window (since / until) or scope (tenant) and export again"
            )
        files.append(EvidencePackFile(path=path, content=content))
        file_entries.append(
            EvidenceFileEntry(
                path=path,
                sha256=hashlib.sha256(content).hexdigest(),
                bytes=len(content),
                records=records,
            )
        )

    add_text_file("events.jsonl", _json_lines([_event_wire(e) for e in events]), len(events))
    add_text_file(
        "approvals.jsonl", _json_lines([_event_wire(e) for e in approvals]), len(approvals)
    )
    add_text_file(
        "promotions.jsonl", _json_lines([_promotion_wire(p) for p in promotions]), len(promotions)
    )
    add_text_file(
        "fixations.jsonl", _json_lines([_fixation_wire(f) for f in fixations]), len(fixations)
    )

    # Sorted by hash so file order is deterministic and independent of dict insertion order (needed for
    # the cross-language golden fixture -- see spec/test/fixtures/evidence-pack/).
    for h in sorted(artifacts_by_hash):
        add_text_file(f"artifacts/{h}.html", artifacts_by_hash[h])

    manifest = EvidenceManifest(
        format=EVIDENCE_PACK_FORMAT,
        version=EVIDENCE_PACK_VERSION,
        generator=generator,
        generatedAt=now(),
        scope=EvidenceManifestScope(tenant=scope.tenant, since=scope.since, until=scope.until),
        counts=EvidenceManifestCounts(
            events=len(events),
            approvals=len(approvals),
            promotions=len(promotions),
            fixations=len(fixations),
            artifacts=len(artifacts_by_hash),
        ),
        complete=complete,
        files=file_entries,
        warnings=warnings,
        signer=signer,
    )

    return BuiltEvidencePack(manifest=manifest, files=files)


# --- sign.ts ---


def _require_ed25519() -> Any:
    """Lazily imports cryptography's Ed25519 module (the `evidence` optional extra), the same
    lazy-import-and-guard convention `kohaku.llm.adapters.anthropic_native` uses for the `anthropic` SDK."""
    try:
        from cryptography.hazmat.primitives.asymmetric import ed25519
    except ImportError as err:
        raise ImportError(
            "Evidence pack signing/verification requires the `cryptography` package. "
            "Run `pip install 'kohaku-ui[evidence]'`."
        ) from err
    return ed25519


def _require_serialization() -> Any:
    try:
        from cryptography.hazmat.primitives import serialization
    except ImportError as err:
        raise ImportError(
            "Evidence pack signing/verification requires the `cryptography` package. "
            "Run `pip install 'kohaku-ui[evidence]'`."
        ) from err
    return serialization


@dataclass(frozen=True)
class Ed25519KeyPair:
    private_key: Ed25519PrivateKey
    public_key: Ed25519PublicKey


def generate_ed25519_keypair() -> Ed25519KeyPair:
    """Generates a fresh Ed25519 keypair (kohaku's evidence-pack tooling equivalent of `kohaku evidence keygen`)."""
    ed25519 = _require_ed25519()
    private_key = ed25519.Ed25519PrivateKey.generate()
    return Ed25519KeyPair(private_key=private_key, public_key=private_key.public_key())


def export_ed25519_private_key_pkcs8(key: Ed25519PrivateKey) -> bytes:
    """Exports a private key as PKCS8 DER bytes (PEM-encode this as `-----BEGIN PRIVATE KEY-----`)."""
    serialization = _require_serialization()
    return key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )


def export_ed25519_public_key_spki(key: Ed25519PublicKey) -> bytes:
    """Exports a public key as SPKI DER bytes (PEM-encode this as `-----BEGIN PUBLIC KEY-----`)."""
    serialization = _require_serialization()
    return key.public_bytes(
        encoding=serialization.Encoding.DER, format=serialization.PublicFormat.SubjectPublicKeyInfo
    )


def export_ed25519_public_key_raw(key: Ed25519PublicKey) -> bytes:
    """Exports a public key as raw bytes (the 32-byte Ed25519 point) -- `derive_ed25519_key_id`'s input."""
    serialization = _require_serialization()
    return key.public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )


def import_ed25519_private_key_pkcs8(pkcs8: bytes) -> Ed25519PrivateKey:
    """Imports an Ed25519 private key from PKCS8 DER bytes."""
    serialization = _require_serialization()
    key = serialization.load_der_private_key(pkcs8, password=None)
    return cast("Ed25519PrivateKey", key)


def import_ed25519_public_key_spki(spki: bytes) -> Ed25519PublicKey:
    """Imports an Ed25519 public key from SPKI DER bytes."""
    serialization = _require_serialization()
    return cast("Ed25519PublicKey", serialization.load_der_public_key(spki))


def import_ed25519_public_key_raw(raw: bytes) -> Ed25519PublicKey:
    """Imports an Ed25519 public key from raw bytes (the 32-byte point) -- used directly by an RFC 8032
    test vector."""
    ed25519 = _require_ed25519()
    return cast("Ed25519PublicKey", ed25519.Ed25519PublicKey.from_public_bytes(raw))


def derive_ed25519_key_id(public_key_raw: bytes) -> str:
    """`manifest.signer.keyId`: the first 16 hex characters of sha256 of the raw public key bytes. Pure
    stdlib (hashlib) -- unlike the rest of this section, it needs no optional dependency."""
    return hashlib.sha256(public_key_raw).hexdigest()[:16]


def sign_bytes(message: bytes, private_key: Ed25519PrivateKey) -> bytes:
    """Signs an arbitrary byte message with an Ed25519 private key -- the primitive `sign_manifest` builds on."""
    signature: bytes = private_key.sign(message)
    return signature


def verify_bytes(message: bytes, signature: bytes, public_key: Ed25519PublicKey) -> bool:
    """Verifies an arbitrary byte message's Ed25519 signature -- the primitive `verify_manifest_signature`
    builds on."""
    from cryptography.exceptions import InvalidSignature

    try:
        public_key.verify(signature, message)
        return True
    except InvalidSignature:
        return False


def sign_manifest(manifest: EvidenceManifest, private_key: Ed25519PrivateKey) -> str:
    """Signs a manifest's canonical JSON form with an Ed25519 private key. Returns the base64
    signature -- the exact text manifest.sig holds."""
    message = canonical_stringify(manifest.canonical_dict()).encode("utf-8")
    signature = sign_bytes(message, private_key)
    return base64.b64encode(signature).decode("ascii")


def verify_manifest_signature(
    manifest: EvidenceManifest | dict[str, Any], signature_base64: str, public_key: Ed25519PublicKey
) -> bool:
    """Verifies a manifest's signature (manifest.sig's base64 contents) against an Ed25519 public key.

    `manifest` is an EvidenceManifest or, as verify_evidence_pack passes it, the raw `json.loads` result
    of manifest.json: the signed value is the raw JSON, so a schema-parsed copy (which could drop or
    default fields) must not stand in for it. A malformed signature is a failed verification, not a raise.
    """
    value = manifest.canonical_dict() if isinstance(manifest, EvidenceManifest) else manifest
    message = canonical_stringify(value).encode("utf-8")
    try:
        signature = base64.b64decode(signature_base64.strip())
    except ValueError:
        return False
    return verify_bytes(message, signature, public_key)


# Hard caps verify_evidence_pack enforces before reading, independent of what any particular reader's
# size() reports -- a legitimately-signed manifest should never need a file this large, and refusing
# outright is simpler and safer than trying to stream-hash an arbitrarily large one.
_MAX_MANIFEST_JSON_BYTES: Final = 16 * 1024 * 1024  # 16 MiB
_MAX_MANIFEST_SIG_BYTES: Final = 1 * 1024 * 1024  # 1 MiB (a base64 Ed25519 signature is ~88 bytes)
_MAX_FILE_BYTES: Final = MAX_EVIDENCE_FILE_BYTES  # shared with build_evidence_pack


async def _try_size(reader: EvidencePackReader, path: str) -> int | None:
    """reader.size(path) if the reader implements it (see EvidencePackReader's docstring), tolerating a
    reader that doesn't (returns None) or one whose size() raises for this path (also None -- the
    subsequent read surfaces its own error)."""
    if not hasattr(reader, "size"):
        return None
    try:
        # reader.size is not a declared EvidencePackReader member (see its doc comment), so mypy only
        # knows about it via the hasattr narrowing above, as an untyped (Any) attribute -- cast documents
        # the actual contract (an optional `async def size(self, path: str) -> int`) at the one call site.
        return cast(int, await reader.size(path))
    except Exception:  # noqa: BLE001 - any failure here just means "unknown", not a verify failure
        return None


class EvidencePackReader(Protocol):
    """Reads a built pack's contents back for `verify_evidence_pack`. This module has no filesystem
    access of its own -- the caller supplies this over whatever storage the pack actually lives on.

    `size` (the byte size of "manifest.json" / "manifest.sig" / a files[] entry's path, without reading
    its content) is a *genuinely optional* extension, like `EvidenceSource.page_lineage` above -- and for
    the same reason, deliberately **not** declared as a member of this Protocol (TS's counterpart is a
    real optional interface field, `size?()`; Python has no equivalent that would not force every
    existing reader, including test doubles, to grow a new method). `verify_evidence_pack` checks for it
    with a plain `hasattr(reader, "size")` probe, the same convention `kohaku.spec.ports.StoragePort`
    documents for `page_lineage`. A reader that omits it still gets the same hash/size cross-check, just
    after the (potentially large) read rather than before it."""

    async def read_manifest(self) -> bytes: ...

    async def read_signature(self) -> bytes: ...

    async def read_file(self, path: str) -> bytes: ...

    async def list_files(self) -> list[str]:
        """Every path physically present in the pack, relative to the pack root, in the same string
        form as manifest.files[].path (plus "manifest.json" / "manifest.sig" themselves). Used by
        verify_evidence_pack to catch a file smuggled into an otherwise-valid pack that the (signed)
        manifest never lists -- a signature over the manifest alone cannot detect an *addition* to the
        pack directory, only a change to something the manifest already references."""
        ...

    # async def size(self, path: str) -> int: ...  # see the docstring above for why this stays commented out


@dataclass(frozen=True)
class VerifyEvidencePackResult:
    ok: bool
    manifest: EvidenceManifest | None
    errors: list[str]
    mismatches: list[str]


def _parse_jsonl(text: str) -> tuple[list[Any], list[int]]:
    """Parses a jsonl file's non-empty lines. The second element is the 1-based numbers of lines that are
    not valid JSON: this only ever runs on content whose hash already matched the signed manifest, so an
    unparseable line is a defect in what the exporter signed, not something a hash check has caught."""
    records: list[Any] = []
    bad_lines: list[int] = []
    for number, line in enumerate(text.split("\n"), start=1):
        if line == "":
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            bad_lines.append(number)
    return records, bad_lines


def _artifact_claims_from_jsonl_records(path: str, records: list[Any]) -> list[ArtifactClaim]:
    claims: list[ArtifactClaim] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        claim: ArtifactClaim | None = None
        if path in ("events.jsonl", "approvals.jsonl"):
            type_ = record.get("type")
            payload = record.get("payload")
            if isinstance(type_, str) and isinstance(payload, dict):
                claim = artifact_claim_from_event_payload(type_, payload)
        elif path == "promotions.jsonl":
            artifact_id = record.get("artifactId")
            data = record.get("data")
            if isinstance(artifact_id, str) and isinstance(data, dict):
                claim = artifact_claim_from_promotion_data(artifact_id, data)
        if claim is not None:
            claims.append(claim)
    return claims


async def verify_evidence_pack(
    reader: EvidencePackReader, public_key: Ed25519PublicKey
) -> VerifyEvidencePackResult:
    """Verifies a Compliance Evidence Pack: the manifest's signature verifies against `public_key` over
    the raw manifest.json value, the manifest then matches EvidenceManifest's schema, the pack directory contains no file the manifest does not list, every
    file the manifest lists has the exact hash/size the manifest recorded, and -- as an independent,
    best-effort cross-check -- every artifact reference found inside the jsonl files actually hashes to
    the value it claims.

    Fails closed on a bad signature: once the signature does not verify, nothing else about the manifest
    can be trusted (including the very files[] list that drives every other check), so this returns
    immediately without reading a single other file from `reader`.
    """
    manifest_size = await _try_size(reader, "manifest.json")
    if manifest_size is not None and manifest_size > _MAX_MANIFEST_JSON_BYTES:
        return VerifyEvidencePackResult(
            ok=False,
            manifest=None,
            errors=[
                f"manifest.json is {manifest_size} bytes, exceeding the {_MAX_MANIFEST_JSON_BYTES}-byte "
                "cap; refusing to read it"
            ],
            mismatches=[],
        )
    manifest_bytes = await reader.read_manifest()
    try:
        raw = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        return VerifyEvidencePackResult(
            ok=False, manifest=None, errors=[f"manifest.json is not valid JSON: {e}"], mismatches=[]
        )

    signature_size = await _try_size(reader, "manifest.sig")
    if signature_size is not None and signature_size > _MAX_MANIFEST_SIG_BYTES:
        return VerifyEvidencePackResult(
            ok=False,
            manifest=None,
            errors=[
                f"manifest.sig is {signature_size} bytes, exceeding the {_MAX_MANIFEST_SIG_BYTES}-byte "
                "cap; refusing to read it"
            ],
            mismatches=[],
        )
    signature_text = (await reader.read_signature()).decode("utf-8").strip()
    # The signature is checked over the raw parsed JSON, before schema validation: the model is not the
    # signed value (a lax parse would drop unknown keys and default missing ones, and still verify).
    if not verify_manifest_signature(raw, signature_text, public_key):
        return VerifyEvidencePackResult(
            ok=False,
            manifest=None,
            errors=["manifest.sig does not verify against the given public key for this manifest"],
            mismatches=[],
        )
    null_path = _find_json_null(raw)
    if null_path is not None:
        return VerifyEvidencePackResult(
            ok=False,
            manifest=None,
            errors=[
                "manifest.json does not match EvidenceManifestSchema: "
                f"null is not allowed (at {null_path})"
            ],
            mismatches=[],
        )
    try:
        manifest = EvidenceManifest.model_validate(raw)
    except ValidationError as e:
        return VerifyEvidencePackResult(
            ok=False,
            manifest=None,
            errors=[f"manifest.json does not match EvidenceManifestSchema: {e}"],
            mismatches=[],
        )

    errors: list[str] = []
    mismatches: list[str] = []

    # The manifest is now signature-verified, so its own files list is trustworthy -- but the pack
    # directory itself might still carry a file that list never mentions (smuggled in after signing,
    # since a signature over the manifest cannot itself notice an addition to the directory).
    listed_paths = {entry.path for entry in manifest.files}
    actual_paths = await reader.list_files()
    unexpected = [p for p in actual_paths if p not in ("manifest.json", "manifest.sig") and p not in listed_paths]
    if unexpected:
        errors.append(f"unexpected file(s) present in the pack but not listed in the manifest: {', '.join(unexpected)}")

    for entry in manifest.files:
        # Defense in depth: EvidenceFileEntry already constrains `path` to a closed set of safe shapes,
        # so this should never actually fail for a manifest that parsed -- but the read that follows
        # drives a filesystem access from data this function does not otherwise re-validate, so the
        # check is repeated here rather than relying solely on the schema continuing to enforce it.
        if not is_safe_evidence_file_path(entry.path):
            errors.append(f"{entry.path}: not a safe evidence-pack path, refusing to read it")
            continue
        # Bounded reads: refuse before ever calling read_file, rather than buffering an oversized or
        # size-mismatched file into memory only to discover the mismatch afterward (see
        # EvidencePackReader's `size` doc comment). The manifest's own entry.bytes cap applies even
        # without a size() reader; the on-disk-size-vs-entry.bytes check additionally needs one.
        if entry.bytes > _MAX_FILE_BYTES:
            errors.append(
                f"{entry.path}: manifest records {entry.bytes} bytes, exceeding the "
                f"{_MAX_FILE_BYTES}-byte cap; refusing to read it"
            )
            continue
        actual_size = await _try_size(reader, entry.path)
        if actual_size is not None and actual_size != entry.bytes:
            errors.append(f"{entry.path}: is {actual_size} bytes on disk, manifest records {entry.bytes}")
            continue
        try:
            content = await reader.read_file(entry.path)
        except Exception as e:  # noqa: BLE001 - any read failure is reported the same way
            errors.append(f"{entry.path}: could not be read ({e})")
            continue
        if len(content) != entry.bytes:
            errors.append(
                f"{entry.path}: is {len(content)} bytes on disk, manifest records {entry.bytes}"
            )
        actual_sha256 = hashlib.sha256(content).hexdigest()
        if actual_sha256 != entry.sha256:
            errors.append(
                f"{entry.path}: sha256 on disk is {actual_sha256}, manifest records {entry.sha256}"
            )
            continue  # The content is not what was signed; an artifact cross-check would be meaningless.
        if entry.path.endswith(".jsonl") and len(content) > 0:
            records, bad_lines = _parse_jsonl(content.decode("utf-8", errors="replace"))
            if bad_lines:
                errors.append(
                    f"{entry.path}: unparseable JSON on line(s) "
                    f"{', '.join(str(n) for n in bad_lines)} of the signed content"
                )
            for claim in _artifact_claims_from_jsonl_records(entry.path, records):
                if claim.claimed_sha256 is None:
                    continue
                actual = sha256_hex(claim.html)
                if actual != claim.claimed_sha256:
                    mismatches.append(
                        f"{entry.path}: artifact {claim.artifact_id} claims sha256 "
                        f"{claim.claimed_sha256}, but sha256 of its own html is {actual}"
                    )

    return VerifyEvidencePackResult(
        ok=len(errors) == 0, manifest=manifest, errors=errors, mismatches=mismatches
    )
