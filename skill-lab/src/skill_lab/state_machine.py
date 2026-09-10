from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, FrozenSet

from .models import ExperimentStatus


class InvalidTransition(RuntimeError):
    pass


_TRANSITIONS: Dict[ExperimentStatus, FrozenSet[ExperimentStatus]] = {
    ExperimentStatus.PENDING: frozenset(
        {ExperimentStatus.BASELINE_RUNNING, ExperimentStatus.CANCELLED}
    ),
    ExperimentStatus.BASELINE_RUNNING: frozenset(
        {
            ExperimentStatus.OPTIMIZING,
            ExperimentStatus.FAILED,
            ExperimentStatus.CANCELLED,
        }
    ),
    ExperimentStatus.OPTIMIZING: frozenset(
        {
            ExperimentStatus.OPTIMIZING,
            ExperimentStatus.VALIDATING,
            ExperimentStatus.NO_IMPROVEMENT,
            ExperimentStatus.FAILED,
            ExperimentStatus.CANCELLED,
        }
    ),
    ExperimentStatus.VALIDATING: frozenset(
        {
            ExperimentStatus.OPTIMIZING,
            ExperimentStatus.COMPLETED,
            ExperimentStatus.NO_IMPROVEMENT,
            ExperimentStatus.FAILED,
            ExperimentStatus.CANCELLED,
        }
    ),
    ExperimentStatus.COMPLETED: frozenset(),
    ExperimentStatus.NO_IMPROVEMENT: frozenset(),
    ExperimentStatus.FAILED: frozenset(),
    ExperimentStatus.CANCELLED: frozenset(),
}


@dataclass
class ExperimentState:
    status: ExperimentStatus = ExperimentStatus.PENDING

    def transition(self, target: ExperimentStatus) -> None:
        if target not in _TRANSITIONS[self.status]:
            raise InvalidTransition(f"cannot transition from {self.status} to {target}")
        self.status = target

