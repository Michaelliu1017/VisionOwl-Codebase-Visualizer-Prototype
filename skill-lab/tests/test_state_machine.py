from __future__ import annotations

import unittest

from skill_lab.models import ExperimentStatus
from skill_lab.state_machine import ExperimentState, InvalidTransition


class StateMachineTests(unittest.TestCase):
    def test_happy_path(self) -> None:
        state = ExperimentState()
        state.transition(ExperimentStatus.BASELINE_RUNNING)
        state.transition(ExperimentStatus.OPTIMIZING)
        state.transition(ExperimentStatus.VALIDATING)
        state.transition(ExperimentStatus.COMPLETED)
        self.assertEqual(state.status, ExperimentStatus.COMPLETED)

    def test_terminal_state_cannot_restart(self) -> None:
        state = ExperimentState(ExperimentStatus.COMPLETED)
        with self.assertRaises(InvalidTransition):
            state.transition(ExperimentStatus.OPTIMIZING)


if __name__ == "__main__":
    unittest.main()

