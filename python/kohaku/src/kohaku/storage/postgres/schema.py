"""The Postgres schema of the StoragePort and the revocation store (port of packages/storage-postgres/src/schema.ts).

**The DDL, the table and index names, and `POSTGRES_SCHEMA_VERSION` are shared with the TS adapter**: both create
the same tables with ``CREATE ... IF NOT EXISTS`` under the same advisory lock, so a TS host and a Python host can
migrate, and then serve, one database. Nothing here may drift from `schema.ts` without a schema-version bump on both
sides, and the tests pin the generated SQL as literals.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

DEFAULT_SCHEMA = "public"

MAX_CORRELATION_COLUMN_LENGTH = 256
"""Longest `correlationId` stored verbatim in `kohaku_lineage.correlation_id`. A btree entry has a hard size limit
(about 2.7 KB), so an oversized value would make the INSERT -- and with it the audit event -- fail."""

POSTGRES_SCHEMA_VERSION = 1
"""The schema version `postgres_schema_sql` produces. Bumped whenever the DDL changes in a way that requires a
manual migration on an already-deployed database. `ready()` records this in `kohaku_schema_meta` on first migrate
and refuses to proceed if a deployed schema is already on a different version (connection.py)."""

MAX_IDENTIFIER_LENGTH = 63
"""PostgreSQL silently truncates an identifier to this many bytes (NAMEDATALEN - 1)."""


def _utf16_length(text: str) -> int:
    """JavaScript's `String.length`: UTF-16 code units, so an astral character counts twice. The 256 limit is
    measured the way the TS adapter measures it."""
    return len(text.encode("utf-16-le")) // 2


def correlation_column_value(correlation_id: str) -> str:
    """The value stored in (and matched against) `kohaku_lineage.correlation_id` for `correlation_id`: the id itself,
    or ``sha256:<hex>`` of its UTF-8 bytes once it exceeds `MAX_CORRELATION_COLUMN_LENGTH`. The event's `record`
    keeps the original. Applied to writes and to the `correlationId` filter alike, so a lookup by the full id still
    finds its rows."""
    if _utf16_length(correlation_id) <= MAX_CORRELATION_COLUMN_LENGTH:
        return correlation_id
    return f"sha256:{hashlib.sha256(correlation_id.encode('utf-8')).hexdigest()}"


def quote_identifier(identifier: str) -> str:
    """Double-quotes a single SQL identifier, doubling any embedded double quotes."""
    return '"' + identifier.replace('"', '""') + '"'


def escape_placeholders(sql: str) -> str:
    """Escapes ``%`` so an identifier can be embedded in a statement that is executed *with* parameters: psycopg
    reads every ``%`` of such a statement as a placeholder, so a schema name containing one (``100%``) would break
    every query. DDL executed without parameters is sent as-is and must not be escaped."""
    return sql.replace("%", "%%")


def qualified_table(schema: str, table: str) -> str:
    """``"schema"."table"`` with embedded double quotes doubled (SQL identifier quoting)."""
    return f"{quote_identifier(schema)}.{quote_identifier(table)}"


_NON_IDENTIFIER = re.compile(r"[^a-z0-9_]")


def _index_prefix(schema: str) -> str:
    """Index names are unquoted identifiers; keep them to [a-z0-9_] by replacing anything else (one underscore
    per UTF-16 code unit, as JavaScript's regex replace does)."""
    return _NON_IDENTIFIER.sub(lambda m: "_" * _utf16_length(m.group(0)), schema.lower())


def _quote_literal(value: str) -> str:
    """A single-quoted SQL string literal, with embedded single quotes doubled."""
    return "'" + value.replace("'", "''") + "'"


@dataclass(frozen=True)
class LineageCorrelationDdl:
    column_name: str
    index_name: str
    add_column_sql: str
    guarded_add_column_sql: str
    create_index_sql: str
    create_index_concurrently_sql: str
    drop_index_concurrently_sql: str


def lineage_correlation_ddl(schema: str = DEFAULT_SCHEMA) -> LineageCorrelationDdl:
    """``kohaku_lineage.correlation_id`` and its ``(correlation_id, seq)`` index (design.md #53). Added after the
    table already existed in deployed databases, so they are kept apart from the base script: ``ALTER TABLE ... ADD
    COLUMN IF NOT EXISTS`` takes an ACCESS EXCLUSIVE lock even when the column is already there, and ``CREATE INDEX
    IF NOT EXISTS`` takes a SHARE lock on the table before it notices the index exists.

    `ready()` checks the catalog first and adds the column (`add_column_sql`, inside the migration transaction) only
    when it is missing. The index is built afterwards, outside any transaction, with
    `create_index_concurrently_sql` on a connection without a statement timeout, and an INVALID leftover of a failed
    build is dropped with `drop_index_concurrently_sql` first. `postgres_schema_sql` (which external migration
    tooling may run as one script) carries the column as a ``DO`` block that issues the ``ALTER`` only when the
    column is absent, and the index as a plain ``CREATE INDEX IF NOT EXISTS``.

    `index_name` is truncated to PostgreSQL's 63-byte identifier limit here, so it is the name the catalog really
    holds. No `POSTGRES_SCHEMA_VERSION` bump."""
    index_name = f"{_index_prefix(schema)}_kohaku_lineage_correlation_id_idx"[
        :MAX_IDENTIFIER_LENGTH
    ]
    table = qualified_table(schema, "kohaku_lineage")
    add_column = f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS correlation_id text NULL"
    return LineageCorrelationDdl(
        column_name="correlation_id",
        index_name=index_name,
        add_column_sql=add_column,
        guarded_add_column_sql=(
            "DO $kohaku_ddl$ BEGIN\n"
            "  IF NOT EXISTS (\n"
            "    SELECT 1 FROM information_schema.columns\n"
            f"     WHERE table_schema = {_quote_literal(schema)} AND table_name = 'kohaku_lineage' "
            "AND column_name = 'correlation_id'\n"
            "  ) THEN\n"
            f"    {add_column};\n"
            "  END IF;\n"
            "END $kohaku_ddl$"
        ),
        create_index_sql=f"CREATE INDEX IF NOT EXISTS {index_name} ON {table} (correlation_id, seq)",
        create_index_concurrently_sql=(
            f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {index_name} ON {table} (correlation_id, seq)"
        ),
        drop_index_concurrently_sql=(
            f"DROP INDEX CONCURRENTLY IF EXISTS {qualified_table(schema, index_name)}"
        ),
    )


def postgres_schema_sql(schema: str = DEFAULT_SCHEMA) -> str:
    """The whole schema as one idempotent script (``CREATE ... IF NOT EXISTS`` only), safe to run on every start.
    tenant is ``''`` for a tenant-neutral record (a NULL cannot take part in a primary key, and
    ``kohaku_lineage.tenant`` follows the same ``''`` convention so a tenant-neutral row is never a SQL NULL anywhere
    in the schema).

    Every JSON payload column (`spec` / `record` / `state`) is ``text``, never the PostgreSQL ``jsonb`` type:
    ``jsonb`` re-serializes an object's keys in its own internal (length, then lexicographic) order on write, so a
    value written then read back comes back with reordered keys at every nesting depth -- byte-inequal but
    semantically identical to what was stored. That silently breaks the byte-exact determinism guarantees built on
    these columns (the Spec cache's exact-JSON-equality check; a fixation's pinnedSpec). None of these columns is
    ever queried into except the compare-and-set predicate, which casts to jsonb for that one comparison only."""
    correlation = lineage_correlation_ddl(schema)
    return f"{postgres_base_schema_sql(schema)}{correlation.guarded_add_column_sql};\n{correlation.create_index_sql};\n"


def postgres_base_schema_sql(schema: str = DEFAULT_SCHEMA) -> str:
    """Everything in `postgres_schema_sql` except the lineage correlation column and index."""

    def t(name: str) -> str:
        return qualified_table(schema, name)

    ix = _index_prefix(schema)
    return f"""
CREATE TABLE IF NOT EXISTS {t("kohaku_spec_cache")} (
  key text PRIMARY KEY,
  spec text NOT NULL,
  expires_at timestamptz NULL
);
CREATE INDEX IF NOT EXISTS {ix}_kohaku_spec_cache_expires_at_idx ON {t("kohaku_spec_cache")} (expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS {t("kohaku_lineage")} (
  seq bigserial PRIMARY KEY,
  id text NOT NULL,
  ts text COLLATE "C" NOT NULL,
  tenant text NOT NULL DEFAULT '',
  type text NOT NULL,
  intent_hash text NULL,
  artifact_id text NULL,
  spec_hash text NULL,
  record text NOT NULL,
  UNIQUE (id)
);
CREATE INDEX IF NOT EXISTS {ix}_kohaku_lineage_type_idx ON {t("kohaku_lineage")} (type, seq);
CREATE INDEX IF NOT EXISTS {ix}_kohaku_lineage_tenant_idx ON {t("kohaku_lineage")} (tenant, seq);
CREATE INDEX IF NOT EXISTS {ix}_kohaku_lineage_intent_hash_idx ON {t("kohaku_lineage")} (intent_hash, seq);
CREATE INDEX IF NOT EXISTS {ix}_kohaku_lineage_artifact_id_idx ON {t("kohaku_lineage")} (artifact_id, seq);
CREATE INDEX IF NOT EXISTS {ix}_kohaku_lineage_spec_hash_idx ON {t("kohaku_lineage")} (spec_hash, seq);
CREATE INDEX IF NOT EXISTS {ix}_kohaku_lineage_ts_idx ON {t("kohaku_lineage")} (ts);
CREATE TABLE IF NOT EXISTS {t("kohaku_promotion_state")} (
  tenant text NOT NULL DEFAULT '',
  artifact_id text NOT NULL,
  seq bigserial NOT NULL,
  state text NOT NULL,
  PRIMARY KEY (tenant, artifact_id)
);
CREATE INDEX IF NOT EXISTS {ix}_kohaku_promotion_state_seq_idx ON {t("kohaku_promotion_state")} (seq);
CREATE TABLE IF NOT EXISTS {t("kohaku_fixation")} (
  tenant text NOT NULL DEFAULT '',
  intent_hash text NOT NULL,
  seq bigserial NOT NULL,
  record text NOT NULL,
  PRIMARY KEY (tenant, intent_hash)
);
CREATE INDEX IF NOT EXISTS {ix}_kohaku_fixation_seq_idx ON {t("kohaku_fixation")} (seq);
-- Unlike the five tables above, this one carries no JSON payload column -- just a jti and its own
-- expiry -- so postgresSchemaSql's doc comment on payload-column typing does not apply to it.
CREATE TABLE IF NOT EXISTS {t("kohaku_capability_revocation")} (
  jti text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS {ix}_kohaku_capability_revocation_expires_at_idx ON {t("kohaku_capability_revocation")} (expires_at);
-- Schema versioning (see POSTGRES_SCHEMA_VERSION's doc comment / connection.ts's ready()): a single
-- row, enforced by the fixed-id primary key + CHECK below rather than an application-level invariant.
CREATE TABLE IF NOT EXISTS {t("kohaku_schema_meta")} (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version integer NOT NULL
);
"""
