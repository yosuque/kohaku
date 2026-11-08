"""kohaku.domain_mcp — an existing MCP server as a kohaku DomainPort (port of packages/domain-mcp).

Read-only tools (`annotations.read_only_hint is True`) become `query://` refs; every other tool becomes an
`approve`-tier governed Action. Depends only on `kohaku.spec`, `kohaku.data_binding` and `kohaku.intents`: the MCP
client is passed in (the official SDK's `Client` satisfies `McpToolClientLike`), and nothing here imports `mcp`,
so this package imports fine without the `mcp` extra (`pip install 'kohaku-ui[mcp]'` is needed only to build the
client).
"""

from .coerce import McpArgumentError, coerce_tool_arguments
from .data_version import DEFAULT_BUCKET_SECONDS, mcp_data_version
from .intents import create_mcp_intents
from .port import (
    McpDomainPort,
    SchemaProjectionReport,
    SkipReport,
    create_mcp_domain_port,
)
from .schema_projection import SchemaProjection, project_input_schema
from .shape import shape_from_output_schema
from .tabular import (
    COLUMN_INFERENCE_ROWS,
    McpResultError,
    McpToolError,
    find_row_list,
    infer_columns,
    to_tabular_data,
)
from .types import McpCallResult, McpToolClientLike, McpToolInfo

__all__ = [
    "COLUMN_INFERENCE_ROWS",
    "DEFAULT_BUCKET_SECONDS",
    "McpArgumentError",
    "McpCallResult",
    "McpDomainPort",
    "McpResultError",
    "McpToolClientLike",
    "McpToolError",
    "McpToolInfo",
    "SchemaProjection",
    "SchemaProjectionReport",
    "SkipReport",
    "coerce_tool_arguments",
    "create_mcp_domain_port",
    "create_mcp_intents",
    "find_row_list",
    "infer_columns",
    "mcp_data_version",
    "project_input_schema",
    "shape_from_output_schema",
    "to_tabular_data",
]
