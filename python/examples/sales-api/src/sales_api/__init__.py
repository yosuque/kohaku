"""kohaku sample: sales domain layer (port of TS: apps/sample-api's domain layer).

Provides the domain (aggregation queries), Intent catalog, Port implementations (Semantic / Authz), write effects, and
few-shot supply. The wiring of the REST/MCP hosts is done by a separate layer.
"""

from .action_effects import ActionEffect, sales_action_effects
from .authz_port import HmacAuthzPort, create_hmac_authz_port
from .catalog import sales_contribution, sales_kpi_card
from .domain import (
    OPERATIONS,
    Product,
    SalesRecord,
    SalesRepo,
    SalesTarget,
    default_seed_dir,
    shape_of,
)
from .fewshot import create_fixation_fewshot
from .intents_catalog import INTENT_DEFINITIONS, INTENT_DEFS, IntentCatalog
from .promoted import PromotedEntry, promoted_component, promoted_intent
from .semantic_port import SalesSemanticPort, create_semantic_port, fiscal_period_of

__all__ = [
    "INTENT_DEFINITIONS",
    "INTENT_DEFS",
    "OPERATIONS",
    "ActionEffect",
    "HmacAuthzPort",
    "IntentCatalog",
    "Product",
    "PromotedEntry",
    "SalesRecord",
    "SalesRepo",
    "SalesSemanticPort",
    "SalesTarget",
    "create_fixation_fewshot",
    "create_hmac_authz_port",
    "create_semantic_port",
    "default_seed_dir",
    "fiscal_period_of",
    "promoted_component",
    "promoted_intent",
    "sales_action_effects",
    "sales_contribution",
    "sales_kpi_card",
    "shape_of",
]
