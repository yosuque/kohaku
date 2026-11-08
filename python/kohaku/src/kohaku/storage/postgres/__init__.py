"""kohaku.storage.postgres -- the PostgreSQL StoragePort and CapabilityRevocationStore reference adapters (port of
the TS `@kohaku-ui/storage-postgres` package). Needs the ``postgres`` extra: ``pip install 'kohaku-ui[postgres]'``
(and ``psycopg[binary]`` unless libpq is installed).

Not re-exported from `kohaku.storage`: psycopg is an optional dependency, so a host that does not use PostgreSQL never
imports it.
"""

from .connection import (
    DEFAULT_CONNECT_TIMEOUT_MS,
    DEFAULT_STATEMENT_TIMEOUT_MS,
    MIGRATION_LOCK_WAIT_MS,
    PostgresPoolHandle,
    create_postgres_pool,
)
from .postgres_storage_port import (
    PostgresStoragePort,
    create_postgres_storage_port,
)
from .revocation import PostgresRevocationStore, create_postgres_revocation_store
from .schema import (
    DEFAULT_SCHEMA,
    MAX_CORRELATION_COLUMN_LENGTH,
    POSTGRES_SCHEMA_VERSION,
    correlation_column_value,
    lineage_correlation_ddl,
    postgres_base_schema_sql,
    postgres_schema_sql,
    qualified_table,
    quote_identifier,
)

__all__ = [
    "DEFAULT_CONNECT_TIMEOUT_MS",
    "DEFAULT_SCHEMA",
    "DEFAULT_STATEMENT_TIMEOUT_MS",
    "MAX_CORRELATION_COLUMN_LENGTH",
    "MIGRATION_LOCK_WAIT_MS",
    "POSTGRES_SCHEMA_VERSION",
    "PostgresPoolHandle",
    "PostgresRevocationStore",
    "PostgresStoragePort",
    "correlation_column_value",
    "create_postgres_pool",
    "create_postgres_revocation_store",
    "create_postgres_storage_port",
    "lineage_correlation_ddl",
    "postgres_base_schema_sql",
    "postgres_schema_sql",
    "qualified_table",
    "quote_identifier",
]
