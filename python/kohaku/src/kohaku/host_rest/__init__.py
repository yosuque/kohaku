"""kohaku.host_rest — host for the Kohaku Protocol REST profile (port of packages/host-rest).

The public API is attach_kohaku_routes(app, deps, prefix). fastapi is a "rest" extra and is not
imported until the attach function is called (when absent, a RuntimeError prompts `pip install 'kohaku-ui[rest]'`).
"""

from .bodies import ComponentUsedEvent, RenderedEvent
from .deps import (
    ActionEffects,
    AnalyticsWindow,
    FixationsApi,
    HostErrorInfo,
    KohakuHostDeps,
    LineageSummarizer,
    PromotionsApi,
    ViewRecorderProtocol,
)
from .errors import error_body
from .governance_policy import (
    GOVERNANCE_OPERATION_KINDS,
    GovernanceEvaluator,
    GovernanceOperation,
    GovernancePolicy,
    create_governance_policy,
)
from .routes import attach_kohaku_routes

__all__ = [
    "GOVERNANCE_OPERATION_KINDS",
    "ActionEffects",
    "AnalyticsWindow",
    "ComponentUsedEvent",
    "FixationsApi",
    "GovernanceEvaluator",
    "GovernanceOperation",
    "GovernancePolicy",
    "KohakuHostDeps",
    "HostErrorInfo",
    "LineageSummarizer",
    "PromotionsApi",
    "RenderedEvent",
    "ViewRecorderProtocol",
    "attach_kohaku_routes",
    "create_governance_policy",
    "error_body",
]
