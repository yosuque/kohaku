"""kohaku.storage.redis -- the Redis StoragePort and CapabilityRevocationStore reference adapters (port of the TS
`@kohaku-ui/storage-redis` package). Needs the ``redis`` extra: ``pip install 'kohaku-ui[redis]'``.

Not re-exported from `kohaku.storage`: the redis-py client is an optional dependency, so a host that does not use
Redis never imports it.
"""

from .connection import (
    DEFAULT_COMMAND_TIMEOUT_MS,
    DEFAULT_CONNECT_TIMEOUT_MS,
    RedisConnection,
    create_redis_connection,
)
from .keys import DEFAULT_KEY_PREFIX, RedisKeys, redis_keys, tenant_segment
from .lineage import LINEAGE_INDEX_FIELDS
from .redis_storage_port import RedisStoragePort, create_redis_storage_port
from .revocation import RedisRevocationStore, create_redis_revocation_store

__all__ = [
    "DEFAULT_COMMAND_TIMEOUT_MS",
    "DEFAULT_CONNECT_TIMEOUT_MS",
    "DEFAULT_KEY_PREFIX",
    "LINEAGE_INDEX_FIELDS",
    "RedisConnection",
    "RedisKeys",
    "RedisRevocationStore",
    "RedisStoragePort",
    "create_redis_connection",
    "create_redis_revocation_store",
    "create_redis_storage_port",
    "redis_keys",
    "tenant_segment",
]
