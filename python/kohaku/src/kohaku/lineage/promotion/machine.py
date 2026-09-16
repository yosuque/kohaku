"""State machine for L2 -> L1 promotion (Port of TS packages/lineage/src/promotion/machine.ts).

Implemented as a table-driven pure function so the conformance test (LIN-PRM-001: a human approve must
precede publish) can be verified.

Differences from TS:
- The discriminated-union PromotionAction represents each variant as a frozen dataclass and branches via
  isinstance (equivalent to TS's switch(action.kind)). Each dataclass keeps the kind field for the audit
  message and the wire representation.
- verdict is a plain dict[str, Any] (a JSON value; like TS's plain object it is persisted as-is into the
  snapshot). verdict["pass"] is used for the decision.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from kohaku.spec import Principal

PromotionStatus = Literal[
    "in_use",
    "candidate",
    "judging",
    "judge_failed",
    "in_review",
    "changes_requested",
    "approved",
    "schema_proposed",
    "published",
    "rejected",
    "withdrawn",
]


@dataclass(frozen=True)
class QueryTemplate:
    """Data wiring for the promotion Intent: mapping of intent params -> query://."""

    path: str
    fixedParams: dict[str, str] | None = None
    paramMap: dict[str, str] | None = None

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {"path": self.path}
        if self.fixedParams is not None:
            out["fixedParams"] = dict(self.fixedParams)
        if self.paramMap is not None:
            out["paramMap"] = dict(self.paramMap)
        return out


def query_template_from_wire(data: dict[str, Any]) -> QueryTemplate:
    return QueryTemplate(
        path=str(data.get("path", "")),
        fixedParams=data.get("fixedParams"),
        paramMap=data.get("paramMap"),
    )


@dataclass(frozen=True)
class ComponentDraft:
    """A promotion draft carrying a JSON Schema for the props (LLM-extracted or human-entered)."""

    componentType: str
    version: str
    intentName: str
    description: str
    paramsJsonSchema: Any = None
    queryTemplate: QueryTemplate | None = None

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "componentType": self.componentType,
            "version": self.version,
            "intentName": self.intentName,
            "description": self.description,
        }
        if self.paramsJsonSchema is not None:
            out["paramsJsonSchema"] = self.paramsJsonSchema
        if self.queryTemplate is not None:
            out["queryTemplate"] = self.queryTemplate.to_wire()
        return out


def component_draft_from_wire(data: dict[str, Any]) -> ComponentDraft:
    query_template = data.get("queryTemplate")
    return ComponentDraft(
        componentType=str(data.get("componentType", "")),
        version=str(data.get("version", "")),
        intentName=str(data.get("intentName", "")),
        description=str(data.get("description", "")),
        paramsJsonSchema=data.get("paramsJsonSchema"),
        queryTemplate=(
            query_template_from_wire(query_template)
            if isinstance(query_template, dict)
            else None
        ),
    )


# --- Promotion actions (discriminated union) ---


@dataclass(frozen=True)
class Nominate:
    by: Principal | Literal["policy"]
    kind: Literal["nominate"] = "nominate"


@dataclass(frozen=True)
class JudgeStart:
    kind: Literal["judge.start"] = "judge.start"


@dataclass(frozen=True)
class JudgeResult:
    # verdict is a plain object with { pass, score, reason?, rubricId?, rubricVersion? }.
    verdict: dict[str, Any]
    kind: Literal["judge.result"] = "judge.result"


@dataclass(frozen=True)
class ReviewStart:
    kind: Literal["review.start"] = "review.start"


@dataclass(frozen=True)
class ReviewApprove:
    reviewer: Principal
    comment: str | None = None
    kind: Literal["review.approve"] = "review.approve"


@dataclass(frozen=True)
class ReviewRequestChanges:
    reviewer: Principal
    comment: str | None = None
    kind: Literal["review.requestChanges"] = "review.requestChanges"


@dataclass(frozen=True)
class ReviewReject:
    reviewer: Principal
    comment: str | None = None
    kind: Literal["review.reject"] = "review.reject"


@dataclass(frozen=True)
class SchemaPropose:
    draft: ComponentDraft
    kind: Literal["schema.propose"] = "schema.propose"


@dataclass(frozen=True)
class Publish:
    version: str
    kind: Literal["publish"] = "publish"


@dataclass(frozen=True)
class Withdraw:
    reason: str | None = None
    kind: Literal["withdraw"] = "withdraw"


@dataclass(frozen=True)
class Unpublish:
    reason: str | None = None
    kind: Literal["unpublish"] = "unpublish"


PromotionAction = (
    Nominate
    | JudgeStart
    | JudgeResult
    | ReviewStart
    | ReviewApprove
    | ReviewRequestChanges
    | ReviewReject
    | SchemaPropose
    | Publish
    | Withdraw
    | Unpublish
)

Review = ReviewApprove | ReviewRequestChanges | ReviewReject


@dataclass(frozen=True)
class MachinePolicy:
    """Whether a judge failure blocks promotion (False means it is treated as advisory and proceeds to in_review)."""

    judgeBlocking: bool = True


_DEFAULT_MACHINE_POLICY = MachinePolicy(judgeBlocking=True)

_TERMINAL: tuple[PromotionStatus, ...] = ("published", "rejected", "withdrawn")

# Statuses whose snapshot may still have a projection (catalog/Intent entry) that reconcile() needs to
# converge: "published" (the live projection) and "withdrawn" (a projection removal that may not have
# completed). Every other status has no projection to converge, including "schema_proposed": it carries a
# draft, but a draft alone is never published, so no projection was ever applied for it. Port of TS's
# MAY_HAVE_PROJECTION (packages/lineage/src/promotion/machine.ts).
_MAY_HAVE_PROJECTION: tuple[PromotionStatus, ...] = ("published", "withdrawn")


def may_have_projection(status: PromotionStatus) -> bool:
    """Whether `status`'s snapshot may still have a projection to converge (see `_MAY_HAVE_PROJECTION`'s doc)."""
    return status in _MAY_HAVE_PROJECTION


class TransitionError(Exception):
    """An invalid state transition (an action the machine does not allow)."""

    def __init__(self, status: str, action: str) -> None:
        super().__init__(
            f'invalid promotion transition: {action} is not allowed in status "{status}"'
        )
        self.name = "TransitionError"


def transition(
    status: PromotionStatus,
    action: PromotionAction,
    policy: MachinePolicy = _DEFAULT_MACHINE_POLICY,
) -> PromotionStatus:
    """Pure-function state transition. An invalid transition throws TransitionError."""
    if isinstance(action, Withdraw):
        if is_terminal(status):
            raise TransitionError(status, action.kind)
        return "withdrawn"

    if status in ("in_use", "judge_failed", "changes_requested"):
        if isinstance(action, Nominate):
            return "candidate"
    elif status == "candidate":
        if isinstance(action, JudgeStart):
            return "judging"
        if isinstance(action, ReviewStart):
            return "in_review"  # path that skips judge (a record still remains)
    elif status == "judging":
        if isinstance(action, JudgeResult):
            passed = bool(action.verdict.get("pass"))
            return "in_review" if (passed or not policy.judgeBlocking) else "judge_failed"
    elif status == "in_review":
        if isinstance(action, ReviewApprove):
            return "approved"
        if isinstance(action, ReviewRequestChanges):
            return "changes_requested"
        if isinstance(action, ReviewReject):
            return "rejected"
    elif status == "approved":
        if isinstance(action, SchemaPropose):
            return "schema_proposed"
    elif status == "schema_proposed":
        if isinstance(action, Publish):
            return "published"
    elif status == "published":
        # Withdrawal from published: the target state does not create a new state but reuses withdrawn.
        # A published->withdrawn via the withdraw action (not unpublish) remains a TransitionError.
        if isinstance(action, Unpublish):
            return "withdrawn"

    raise TransitionError(status, action.kind)


def is_terminal(status: PromotionStatus) -> bool:
    return status in _TERMINAL
