"""Tests for kohaku.storage.postgres.schema (port of packages/storage-postgres/test/schema.test.ts and the
`correlationColumnValue` case of lineage.test.ts). The generated DDL is additionally pinned byte-for-byte to the TS
output by the cross-language golden (test_storage_layout_golden.py)."""

from __future__ import annotations

import re

from kohaku.storage.postgres import (
    MAX_CORRELATION_COLUMN_LENGTH,
    POSTGRES_SCHEMA_VERSION,
    correlation_column_value,
    lineage_correlation_ddl,
    postgres_schema_sql,
    qualified_table,
)


class TestQualifiedTable:
    def test_double_quotes_and_escapes_identifiers(self) -> None:
        assert qualified_table("public", "kohaku_lineage") == '"public"."kohaku_lineage"'
        assert qualified_table('we"ird', "t") == '"we""ird"."t"'


class TestPostgresSchemaSql:
    sql = postgres_schema_sql()

    def test_creates_the_tables_idempotently_in_the_default_schema(self) -> None:
        for table in (
            "kohaku_spec_cache",
            "kohaku_lineage",
            "kohaku_promotion_state",
            "kohaku_fixation",
            "kohaku_capability_revocation",
            "kohaku_schema_meta",
        ):
            assert f'CREATE TABLE IF NOT EXISTS "public"."{table}"' in self.sql
        assert re.search(r"CREATE TABLE (?!IF NOT EXISTS)", self.sql) is None

    def test_prefixes_index_names_with_the_schema(self) -> None:
        assert "CREATE INDEX IF NOT EXISTS tenant_a_kohaku_lineage_type_idx" in postgres_schema_sql(
            "tenant_a"
        )
        assert "CREATE INDEX IF NOT EXISTS public_kohaku_lineage_type_idx" in self.sql

    def test_never_uses_jsonb_every_json_payload_column_is_text(self) -> None:
        assert re.search(r"\bjsonb\b", self.sql) is None
        assert "spec text NOT NULL" in self.sql
        assert "record text NOT NULL" in self.sql
        assert "state text NOT NULL" in self.sql

    def test_collates_the_lineage_ts_column_as_c(self) -> None:
        assert 'ts text COLLATE "C" NOT NULL' in self.sql

    def test_adds_the_expiry_and_seq_indexes(self) -> None:
        assert (
            'CREATE INDEX IF NOT EXISTS public_kohaku_spec_cache_expires_at_idx ON "public"."kohaku_spec_cache" '
            "(expires_at) WHERE expires_at IS NOT NULL" in self.sql
        )
        assert (
            'CREATE INDEX IF NOT EXISTS public_kohaku_promotion_state_seq_idx ON "public"."kohaku_promotion_state" (seq)'
            in self.sql
        )
        assert (
            'CREATE INDEX IF NOT EXISTS public_kohaku_fixation_seq_idx ON "public"."kohaku_fixation" (seq)'
            in self.sql
        )

    def test_requires_the_lineage_id_to_be_unique(self) -> None:
        assert re.search(r"kohaku_lineage[\s\S]*UNIQUE \(id\)", self.sql)

    def test_adds_the_correlation_id_column_additively_without_bumping_the_schema_version(
        self,
    ) -> None:
        assert re.search(
            r"DO \$kohaku_ddl\$ BEGIN\s+IF NOT EXISTS \(\s+SELECT 1 FROM information_schema\.columns\s+"
            r"WHERE table_schema = 'public' AND table_name = 'kohaku_lineage' AND column_name = 'correlation_id'"
            r"\s+\) THEN\s+ALTER TABLE \"public\"\.\"kohaku_lineage\" ADD COLUMN IF NOT EXISTS correlation_id "
            r"text NULL;\s+END IF;\s+END \$kohaku_ddl\$;",
            self.sql,
        )
        assert (
            'CREATE INDEX IF NOT EXISTS public_kohaku_lineage_correlation_id_idx ON "public"."kohaku_lineage" '
            "(correlation_id, seq)" in self.sql
        )
        assert POSTGRES_SCHEMA_VERSION == 1

    def test_escapes_a_schema_name_inside_the_guarded_column_ddls_string_literal(self) -> None:
        assert "table_schema = 'o''brien'" in postgres_schema_sql("o'brien")

    def test_truncates_the_correlation_index_name_to_the_63_byte_identifier_limit(self) -> None:
        ddl = lineage_correlation_ddl("s" + "x" * 80)
        assert len(ddl.index_name) == 63
        assert f" IF NOT EXISTS {ddl.index_name} ON " in ddl.create_index_concurrently_sql

    def test_makes_the_schema_meta_table_a_single_row_table(self) -> None:
        assert re.search(
            r"kohaku_schema_meta[\s\S]*id integer PRIMARY KEY DEFAULT 1 CHECK \(id = 1\)", self.sql
        )
        assert re.search(r"kohaku_schema_meta[\s\S]*version integer NOT NULL", self.sql)

    def test_replaces_every_non_identifier_character_of_the_schema_in_index_names(self) -> None:
        sql = postgres_schema_sql("Mixed-Case.\U0001f600")
        # JavaScript's regex replace works per UTF-16 code unit, so an astral character becomes two underscores.
        assert "CREATE INDEX IF NOT EXISTS mixed_case____kohaku_lineage_type_idx" in sql


class TestCorrelationColumnValue:
    def test_keeps_an_id_at_or_under_the_bound_verbatim_and_digests_a_longer_one(self) -> None:
        at_bound = "a" * MAX_CORRELATION_COLUMN_LENGTH
        assert correlation_column_value(at_bound) == at_bound
        longer = at_bound + "b"
        assert re.fullmatch(r"sha256:[0-9a-f]{64}", correlation_column_value(longer))
        assert correlation_column_value(longer) == correlation_column_value(longer)
        assert correlation_column_value(longer) != correlation_column_value(at_bound + "c")

    def test_pins_the_digest_of_a_long_id_to_the_ts_value(self) -> None:
        # node -e 'console.log("sha256:"+require("crypto").createHash("sha256").update("a".repeat(257),"utf8").digest("hex"))'
        assert correlation_column_value("a" * 257) == (
            "sha256:e8d95cc2b4bc198c54b40bd214df958afb65f5e73d2c2eafe0593cf5c635c1f0"
        )

    def test_measures_the_bound_in_utf16_code_units_like_the_ts_adapter(self) -> None:
        # 129 astral characters are 129 code points but 258 UTF-16 code units: over the bound in TS, so digested.
        assert correlation_column_value("\U0001f600" * 129).startswith("sha256:")
        assert correlation_column_value("\U0001f600" * 128) == "\U0001f600" * 128
