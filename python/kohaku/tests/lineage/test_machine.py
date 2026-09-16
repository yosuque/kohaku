"""Tests for the promotion state machine (pytest port of packages/lineage/test/machine.test.ts)."""

from __future__ import annotations

import pytest

from kohaku.lineage import (
    ComponentDraft,
    JudgeResult,
    JudgeStart,
    MachinePolicy,
    Nominate,
    Publish,
    ReviewApprove,
    ReviewReject,
    ReviewRequestChanges,
    ReviewStart,
    SchemaPropose,
    TransitionError,
    Unpublish,
    Withdraw,
    transition,
)
from kohaku.spec import Principal

REVIEWER = Principal(id="alice")
DRAFT = ComponentDraft(
    componentType="sales.calendarHeatmap",
    version="1.0.0",
    intentName="sales.calendar_heatmap",
    description="Heatmap",
)


def test_canonical_promotion_path() -> None:
    s = transition("in_use", Nominate(by="policy"))
    assert s == "candidate"
    s = transition(s, JudgeStart())
    assert s == "judging"
    s = transition(s, JudgeResult(verdict={"pass": True, "score": 0.8}))
    assert s == "in_review"
    s = transition(s, ReviewApprove(reviewer=REVIEWER))
    assert s == "approved"
    s = transition(s, SchemaPropose(draft=DRAFT))
    assert s == "schema_proposed"
    s = transition(s, Publish(version="1.0.0"))
    assert s == "published"


def test_lin_prm_001_no_publish_without_human_approve() -> None:
    for status in ("in_use", "candidate", "judging", "in_review"):
        with pytest.raises(TransitionError):
            transition(status, Publish(version="1.0.0"))
    # Even from approved, you cannot publish without going through schema.propose
    with pytest.raises(TransitionError):
        transition("approved", Publish(version="1.0.0"))


def test_judge_fail_blocking_vs_advisory() -> None:
    fail = JudgeResult(verdict={"pass": False, "score": 0.2})
    assert transition("judging", fail, MachinePolicy(judgeBlocking=True)) == "judge_failed"
    assert transition("judging", fail, MachinePolicy(judgeBlocking=False)) == "in_review"
    # From judge_failed, re-nomination can recover it
    assert transition("judge_failed", Nominate(by="policy")) == "candidate"


def test_reject_request_changes_withdraw() -> None:
    assert transition("in_review", ReviewReject(reviewer=REVIEWER)) == "rejected"
    assert transition("in_review", ReviewRequestChanges(reviewer=REVIEWER)) == "changes_requested"
    assert transition("changes_requested", Nominate(by=REVIEWER)) == "candidate"
    assert transition("candidate", Withdraw()) == "withdrawn"
    # A withdraw from a terminal state is not allowed
    with pytest.raises(TransitionError):
        transition("published", Withdraw())


def test_review_start_skips_judge_but_keeps_human_approve() -> None:
    s = transition("candidate", ReviewStart())
    assert s == "in_review"
    assert transition(s, ReviewApprove(reviewer=REVIEWER)) == "approved"


def test_unpublish_published_to_withdrawn() -> None:
    assert transition("published", Unpublish()) == "withdrawn"
    assert transition("published", Unpublish(reason="obsolete")) == "withdrawn"


def test_unpublish_only_from_published() -> None:
    for status in (
        "in_use",
        "candidate",
        "judging",
        "judge_failed",
        "in_review",
        "changes_requested",
        "approved",
        "schema_proposed",
        "rejected",
        "withdrawn",
    ):
        with pytest.raises(TransitionError):
            transition(status, Unpublish())


def test_withdraw_on_published_still_transition_error() -> None:
    # Only the dedicated unpublish action can handle published. withdraw keeps being rejected by the terminal guard.
    with pytest.raises(TransitionError):
        transition("published", Withdraw())
