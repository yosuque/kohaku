---
"@kohaku-ui/lineage": minor
"@kohaku-ui/renderer-core": minor
"@kohaku-ui/renderer-react": minor
"@kohaku-ui/renderer-wc": minor
"@kohaku-ui/cli": minor
---

Adds a Compliance Evidence Pack export (`@kohaku-ui/lineage`'s new `evidence` module; `kohaku evidence
keygen`/`export`/`verify`) and opt-in AI-generation disclosure for both renderers (design.md #66/#67).

**Evidence Pack** (`@kohaku-ui/lineage`): `buildEvidencePack` assembles a normalized, Ed25519-signed
export of the lineage log (`events.jsonl`), a governance-decision index (`approvals.jsonl`:
`component.reviewed`/`published`/`withdrawn`, `intent.fixated`/`unfixated`), promotion/fixation
snapshots, and the referenced component HTML artifacts, plus `manifest.json` and a detached signature
(`manifest.sig`). `EvidenceManifestSchema` is new but deliberately not part of `spec/schemas` — it
describes an export format for auditors, not a wire type. Ed25519 signing uses `globalThis.crypto.subtle`
(no new runtime dependency for TS); an artifact whose recorded hash does not match its own content is
still exported, recorded as a non-fatal warning rather than aborting the export.

**CLI** (`@kohaku-ui/cli`): `kohaku evidence keygen --out-dir <dir>` generates an Ed25519 keypair (private
key file mode 0600). `kohaku evidence export (--data-dir <dir> | --rest <baseUrl> [--header k:v])
[--tenant <id>] --since --until --private-key <pem> --out <dir> [--allow-incomplete]` builds and signs a
pack from a local `StoragePort` data directory or, over REST, from the existing `KohakuClient` surface
(`lineagePages`/`promotions.list`/`fixations.list`) — the REST source leaves `fixations.jsonl` empty with
a recorded warning, since `GET /fixations` does not expose enough fields to reconstruct a full
`FixationRecord`. `kohaku evidence verify <dir> --public-key <pem>` checks the manifest schema, the
signature, and every file's hash/size, and reports an independent artifact-hash cross-check as non-fatal
`mismatches`; exit code 0 valid / 1 invalid / 2 usage error. `@kohaku-ui/lineage` and
`@kohaku-ui/storage-memory` move from `cli`'s devDependencies to dependencies.

**AI-generation disclosure** (`@kohaku-ui/renderer-core`, `@kohaku-ui/renderer-react`,
`@kohaku-ui/renderer-wc`): `deriveDisclosure(provenance)` (renderer-core) derives a disclosure level
(`"ai-generated"` for tier L1/L2, `"ai-assisted-reviewed"` for a fixated tier-L0 Spec, `"none"` otherwise
— never encoded on the wire) and the corresponding `data-kohaku-disclosure`/`data-kohaku-tier`/
`data-digital-source-type` (IPTC Digital Source Type) attributes. `SpecView` gains a `disclosure?: "off" |
"attributes" | "label"` prop (renderer-react; also exports `useDisclosure`/`KohakuDisclosureLabel`), and
`<kohaku-surface>` gains a matching `disclosure` attribute (renderer-wc, applied to the host element,
with the visible label — `"label"` mode only — inside the shadow root). Both default to `"off"`: existing
DOM output is unchanged unless a host opts in.

See [docs/user-guide.md](../docs/user-guide.md)'s "Compliance Evidence Pack and AI-generation disclosure"
section for usage, EU AI Act Article 50 context (not legal advice), and a PII caution for exported Intent
`params`/request text.
