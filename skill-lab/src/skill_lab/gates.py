from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .models import GateDecision, ScoreCard


@dataclass(frozen=True)
class QualityGateConfig:
    minimum_total_score: float = 85.0
    minimum_improvement: float = 20.0
    maximum_violations: int = 0


class QualityGate:
    def __init__(self, config: Optional[QualityGateConfig] = None) -> None:
        self.config = config or QualityGateConfig()

    def decide(
        self,
        baseline: ScoreCard,
        candidate: ScoreCard,
    ) -> GateDecision:
        if candidate.hard_failures:
            return GateDecision.REJECTED
        if len(candidate.violations) > self.config.maximum_violations:
            return GateDecision.REJECTED
        if candidate.total < self.config.minimum_total_score:
            return GateDecision.REJECTED
        if candidate.total - baseline.total < self.config.minimum_improvement:
            return GateDecision.NO_IMPROVEMENT
        return GateDecision.ACCEPTED
