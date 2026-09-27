"""Catalog fingerprint (Port of TS fingerprint.ts). A cache-key component.

Cryptographic strength is not needed, so a synchronous FNV-1a 64-bit is used. Computed over the sorted
join of "type@version" (native entries) or "type@version#fnv1a64(html)" (sandbox-template entries, so a
re-published artifact under the same type@version is distinguished from the one it replaced), with a
"!deprecated" suffix appended for entries that carry a deprecation marker. It necessarily changes when a
part is added, revised, deprecated, or (for a sandbox-template) re-published with different content, and
symmetrically leaves every other entry's identity string untouched. The TS implementation folds via
charCodeAt (UTF-16 code units), so the Python side matches per UTF-16 code unit too.
"""

from __future__ import annotations

from kohaku.spec.canonical_json import _utf16_key

_FNV_OFFSET = 0xCBF29CE484222325
_FNV_PRIME = 0x100000001B3
_MASK64 = 0xFFFFFFFFFFFFFFFF


def fnv1a64(text: str) -> str:
    hash_value = _FNV_OFFSET
    # Fold over the same UTF-16 code-unit sequence as charCodeAt (outside the BMP = 2 surrogate-pair units)
    encoded = text.encode("utf-16-be", "surrogatepass")
    for i in range(0, len(encoded), 2):
        unit = (encoded[i] << 8) | encoded[i + 1]
        hash_value ^= unit
        hash_value = (hash_value * _FNV_PRIME) & _MASK64
    return format(hash_value, "016x")


def catalog_entry_identity(entry: tuple[str, str, str | None, bool]) -> str:
    """entry is (type, version, sandbox_template_html, deprecated)."""
    type_, version, html, deprecated = entry
    base = f"{type_}@{version}#{fnv1a64(html)}" if html is not None else f"{type_}@{version}"
    return f"{base}!deprecated" if deprecated else base


def catalog_fingerprint(entries: list[tuple[str, str, str | None, bool]]) -> str:
    """entries is a sequence of (type, version, sandbox_template_html, deprecated)."""
    joined = ",".join(sorted((catalog_entry_identity(e) for e in entries), key=_utf16_key))
    return fnv1a64(joined)
