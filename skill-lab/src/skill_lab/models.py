from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, Mapping, Optional, Sequence, Tuple


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def content_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class ExperimentStatus(str, Enum):
    PENDING = "pending"
    BASELINE_RUNNING = "baseline_running"
    OPTIMIZING = "optimizing"
    VALIDATING = "validating"
    COMPLETED = "completed"
    NO_IMPROVEMENT = "no_improvement"
    FAILED = "failed"
    CANCELLED = "cancelled"


class GateDecision(str, Enum):
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    NO_IMPROVEMENT = "no_improvement"
    MANUAL_REVIEW_REQUIRED = "manual_review_required"


@dataclass(frozen=True)
class SkillCandidate:
    id: str
    project_id: str
    version: str
    content: str
    source_repository: str
    source_commit_sha: str
    dataset_id: str
    checksum: str = ""
    target_profile: Mapping[str, Any] = field(default_factory=dict)
    evidence_graph_version: Optional[str] = None

    def __post_init__(self) -> None:
        if not self.id or not self.project_id or not self.version:
            raise ValueError("candidate id, project id and version are required")
        if not self.content.strip():
            raise ValueError("candidate skill content cannot be empty")
        expected = content_hash(self.content)
        if self.checksum and self.checksum != expected:
            raise ValueError("candidate checksum does not match skill content")
        if not self.checksum:
            object.__setattr__(self, "checksum", expected)


@dataclass(frozen=True)
class SkillVersion:
    skill_id: str
    version: str
    content: str
    checksum: str
    parent_version: Optional[str]
    created_at: str
    source_experiment_id: Optional[str] = None

    @classmethod
    def from_candidate(cls, candidate: SkillCandidate) -> "SkillVersion":
        return cls(
            skill_id=candidate.id,
            version=candidate.version,
            content=candidate.content,
            checksum=candidate.checksum,
            parent_version=None,
            created_at=utc_now(),
        )


@dataclass(frozen=True)
class EvaluationTask:
    id: str
    requirement: str
    base_sha: str
    required_rules: Tuple[str, ...]
    allowed_paths: Tuple[str, ...] = ()
    forbidden_paths: Tuple[str, ...] = ()
    critical_rules: Tuple[str, ...] = ()
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.id or not self.requirement or not self.base_sha:
            raise ValueError("task id, requirement and base sha are required")
        if not self.required_rules:
            raise ValueError("an evaluation task needs at least one required rule")


@dataclass(frozen=True)
class EvaluationDataset:
    id: str
    version: str
    development_tasks: Tuple[EvaluationTask, ...]
    validation_tasks: Tuple[EvaluationTask, ...]

    def __post_init__(self) -> None:
        if not self.development_tasks:
            raise ValueError("development dataset cannot be empty")
        if not self.validation_tasks:
            raise ValueError("validation dataset cannot be empty")
        development_ids = {task.id for task in self.development_tasks}
        validation_ids = {task.id for task in self.validation_tasks}
        if development_ids & validation_ids:
            raise ValueError("development and validation tasks must be disjoint")


@dataclass(frozen=True)
class CheckResult:
    name: str
    passed: bool
    critical: bool = True
    details: str = ""


@dataclass(frozen=True)
class ExecutionResult:
    run_id: str
    task_id: str
    skill_version: str
    checks: Tuple[CheckResult, ...]
    changed_files: Tuple[str, ...]
    diff: str
    commands: Tuple[str, ...]
    violations: Tuple[str, ...]
    trace: Mapping[str, Any]
    duration_ms: int
    efficiency_score: float = 100.0
    provider: str = "fake"


@dataclass(frozen=True)
class SemanticAssessment:
    task_id: str
    score: float
    reasons: Tuple[str, ...]
    evidence_refs: Tuple[str, ...]


@dataclass(frozen=True)
class ScoreCard:
    total: float
    correctness: float
    safety_scope: float
    semantic_quality: float
    stability_efficiency: float
    hard_failures: Tuple[str, ...]
    violations: Tuple[str, ...]


@dataclass(frozen=True)
class EvaluationBundle:
    skill_version: str
    execution_results: Tuple[ExecutionResult, ...]
    semantic_assessments: Tuple[SemanticAssessment, ...]
    scorecard: ScoreCard


@dataclass(frozen=True)
class SkillPatch:
    additions: Tuple[str, ...]
    reasons: Tuple[str, ...]
    evidence_refs: Tuple[str, ...]

    @property
    def signature(self) -> str:
        payload = "\n".join(self.additions)
        return content_hash(payload)


@dataclass(frozen=True)
class RoundReport:
    number: int
    candidate_version: str
    patch: SkillPatch
    development_score: ScoreCard
    validation_score: Optional[ScoreCard]
    decision: GateDecision
    note: str


@dataclass(frozen=True)
class ExperimentReport:
    experiment_id: str
    candidate_id: str
    status: ExperimentStatus
    baseline_version: str
    accepted_version: Optional[str]
    baseline_development_score: ScoreCard
    baseline_validation_score: ScoreCard
    rounds: Tuple[RoundReport, ...]
    started_at: str
    finished_at: str
    artifact_refs: Mapping[str, str] = field(default_factory=dict)

    @property
    def final_score(self) -> ScoreCard:
        if not self.rounds:
            return self.baseline_validation_score
        final_round = self.rounds[-1]
        return final_round.validation_score or final_round.development_score


def tuple_of_strings(value: Sequence[Any]) -> Tuple[str, ...]:
    return tuple(str(item) for item in value)

