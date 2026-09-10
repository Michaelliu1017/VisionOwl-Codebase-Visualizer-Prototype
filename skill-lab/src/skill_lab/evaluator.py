from __future__ import annotations

from statistics import mean
from typing import Iterable, Sequence

from .models import ExecutionResult, ScoreCard, SemanticAssessment


class DeterministicEvaluator:
    """Aggregates hard checks and semantic assessments into a scorecard."""

    def __init__(
        self,
        *,
        correctness_weight: float = 0.55,
        safety_weight: float = 0.15,
        semantic_weight: float = 0.20,
        efficiency_weight: float = 0.10,
    ) -> None:
        weights = (
            correctness_weight,
            safety_weight,
            semantic_weight,
            efficiency_weight,
        )
        if abs(sum(weights) - 1.0) > 0.0001:
            raise ValueError("score weights must add up to 1.0")
        self.correctness_weight = correctness_weight
        self.safety_weight = safety_weight
        self.semantic_weight = semantic_weight
        self.efficiency_weight = efficiency_weight

    def score(
        self,
        results: Sequence[ExecutionResult],
        semantic_assessments: Sequence[SemanticAssessment],
    ) -> ScoreCard:
        if not results:
            raise ValueError("at least one execution result is required")

        checks = [check for result in results for check in result.checks]
        correctness = self._ratio(
            sum(1 for check in checks if check.passed),
            len(checks),
        )
        violations = tuple(
            violation for result in results for violation in result.violations
        )
        safety_scope = max(0.0, 100.0 - (25.0 * len(violations)))
        semantic_quality = (
            mean(assessment.score for assessment in semantic_assessments)
            if semantic_assessments
            else 0.0
        )
        stability_efficiency = mean(
            max(0.0, min(100.0, result.efficiency_score)) for result in results
        )
        hard_failures = tuple(
            f"{result.task_id}:{check.name}"
            for result in results
            for check in result.checks
            if check.critical and not check.passed
        )

        total = (
            correctness * self.correctness_weight
            + safety_scope * self.safety_weight
            + semantic_quality * self.semantic_weight
            + stability_efficiency * self.efficiency_weight
        )
        return ScoreCard(
            total=round(total, 2),
            correctness=round(correctness, 2),
            safety_scope=round(safety_scope, 2),
            semantic_quality=round(semantic_quality, 2),
            stability_efficiency=round(stability_efficiency, 2),
            hard_failures=hard_failures,
            violations=violations,
        )

    @staticmethod
    def _ratio(numerator: int, denominator: int) -> float:
        if denominator == 0:
            return 0.0
        return (numerator / denominator) * 100.0

