"""Parse and canonicalize the query:// URI scheme (port of packages/spec-core/src/query-ref.ts).

The single definition site for canonicalization (key sorting). It is a security invariant of two-way
binding that the client's effective ref, capability variant enumeration, and the host's base-ref validation
all resolve to the same canonical form; duplicating canonicalization would break this invariant.

Encoding/decoding matches JS encodeURIComponent / decodeURIComponent exactly (characters other than the
unreserved A-Za-z0-9 -_.!~*'() become %XX uppercase hex; malformed % sequences raise).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .canonical_json import _utf16_key


class QueryRefError(Exception):
    def __init__(self, uri: str, reason: str) -> None:
        super().__init__(f'invalid query ref "{uri}": {reason}')
        self.uri = uri
        self.reason = reason


@dataclass(frozen=True)
class QueryRef:
    source: str
    path: str
    """Kept encoded as-is (not decoded; format_query_ref writes it back verbatim)."""
    params: dict[str, str]
    """Keys/values are decoded. An empty-value parameter `?a` is kept as value "" (canonical form `?a=`)."""
    raw: str
    """The canonical (key-sorted parameters) URI."""


_REF_RE = re.compile(r"^query://([a-z0-9_-]+)/([^?#]+)(?:\?(.*))?$")

# Characters encodeURIComponent does not escape (RFC 2396 unreserved + !*'()).
_UNRESERVED = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
)

_PERCENT_RE = re.compile(r"%(?![0-9A-Fa-f]{2})")


def _encode_uri_component(s: str) -> str:
    """Identical to JS encodeURIComponent (%XX in uppercase hex)."""
    out: list[str] = []
    for ch in s:
        if ch in _UNRESERVED:
            out.append(ch)
        else:
            out.extend(f"%{b:02X}" for b in ch.encode("utf-8"))
    return "".join(out)


def _decode_uri_component(s: str, uri: str) -> str:
    """Identical to JS decodeURIComponent (malformed % sequences / invalid UTF-8 raise)."""
    if _PERCENT_RE.search(s) is not None:
        raise QueryRefError(uri, "malformed percent-encoding")
    parts: list[bytes] = []
    i = 0
    while i < len(s):
        if s[i] == "%":
            parts.append(bytes([int(s[i + 1 : i + 3], 16)]))
            i += 3
        else:
            parts.append(s[i].encode("utf-8"))
            i += 1
    try:
        return b"".join(parts).decode("utf-8")
    except UnicodeDecodeError:
        raise QueryRefError(uri, "malformed percent-encoding (invalid UTF-8)") from None


def parse_query_ref(uri: str) -> QueryRef:
    """Parse a query:// URI. Example: query://sales/summary?fy=2026&groupBy=region&q=3"""
    m = _REF_RE.match(uri)
    if m is None:
        raise QueryRefError(uri, "expected query://<source>/<path>?<params>")
    source, path, query = m.group(1), m.group(2), m.group(3)
    # source is constrained by the regex [a-z0-9_-]+ (only alphanumerics/symbols; no encoding needed, safe).
    # path is kept encoded as-is (format_query_ref writes it back verbatim, so it is invariant round-trip).
    params: dict[str, str] = {}
    if query:
        for pair in query.split("&"):
            if not pair:
                continue
            eq = pair.find("=")
            if eq < 0:
                # An empty-value parameter (a form without =, like `?a`) is kept as value "".
                # As a result it normalizes to `?a=` in canonical form (format_query_ref always uses key=value).
                params[_decode_uri_component(pair, uri)] = ""
            else:
                params[_decode_uri_component(pair[:eq], uri)] = _decode_uri_component(
                    pair[eq + 1 :], uri
                )
    raw = format_query_ref(source=source, path=path, params=params)
    return QueryRef(source=source, path=path, params=params, raw=raw)


def format_query_ref(*, source: str, path: str, params: dict[str, str]) -> str:
    """Return the canonical (key-sorted, encoded) URI. The same reference always becomes the same string."""
    # Sort in the same order as JS Array.prototype.sort() (UTF-16 code-unit order).
    query = "&".join(
        f"{_encode_uri_component(k)}={_encode_uri_component(params[k])}"
        for k in sorted(params.keys(), key=_utf16_key)
    )
    return f"query://{source}/{path}{'?' + query if query else ''}"
