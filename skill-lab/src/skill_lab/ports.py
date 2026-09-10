from __future__ import annotations

from typing import Optional, Protocol, Sequence, Set

from .models import (
    EvaluationTask,
    ExecutionResult,
    ScoreCard,
    SemanticAssessment,
    SkillPatch,
    SkillVersion,
)


class Runner(Protocol):
    def execute(self, skill: SkillVersion, task: EvaluationTask) -> ExecutionResult:
        ...


class SemanticJudge(Protocol):
    def evaluate(
        self,
        skill: SkillVersion,
        task: EvaluationTask,
        result: ExecutionResult,
    ) -> SemanticAssessment:
        ...


class Optimizer(Protocol):
    def propose_patch(
        self,
        skill: SkillVersion,
        tasks: Sequence[EvaluationTask],
        results: Sequence[ExecutionResult],
        assessments: Sequence[SemanticAssessment],
        scorecard: ScoreCard,
        rejected_signatures: Set[str],
    ) -> Optional[SkillPatch]:
        ...
