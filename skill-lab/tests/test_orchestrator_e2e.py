from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from skill_lab.contracts import load_candidate, load_dataset
from skill_lab.serialization import load_json
from skill_lab.service import build_fake_orchestrator


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures" / "visionowl"
GOLDEN = ROOT / "tests" / "golden" / "mock-experiment-summary.json"


class OrchestratorEndToEndTests(unittest.TestCase):
    def test_optimizes_candidate_and_passes_hidden_validation(self) -> None:
        candidate = load_candidate(
            FIXTURES / "candidate.json",
            FIXTURES / "initial-skill.md",
        )
        dataset = load_dataset(FIXTURES / "dataset.json")

        with tempfile.TemporaryDirectory() as directory:
            state_root = Path(directory)
            report = build_fake_orchestrator(state_root).run(
                candidate,
                dataset,
                experiment_id="mock-experiment-1",
            )

            summary = {
                "status": report.status.value,
                "acceptedVersion": report.accepted_version,
                "baselineDevelopmentScore": report.baseline_development_score.total,
                "baselineValidationScore": report.baseline_validation_score.total,
                "finalScore": report.final_score.total,
                "rounds": [
                    {
                        "number": item.number,
                        "additions": list(item.patch.additions),
                        "developmentScore": item.development_score.total,
                        "validationScore": (
                            item.validation_score.total
                            if item.validation_score
                            else None
                        ),
                        "decision": item.decision.value,
                    }
                    for item in report.rounds
                ],
            }
            self.assertEqual(summary, load_json(GOLDEN))

            manifest = load_json(
                state_root
                / "registry"
                / "skills"
                / candidate.id
                / "manifest.json"
            )
            self.assertEqual(manifest["activeVersion"], "0.1.0-opt.2")
            self.assertTrue(Path(report.artifact_refs["report"]).exists())
            self.assertTrue(Path(report.artifact_refs["acceptedSkill"]).exists())

            outbox_events = list(
                (state_root / "outbox" / "mock-experiment-1").glob("*.json")
            )
            self.assertGreaterEqual(len(outbox_events), 4)
            event_types = {
                json.loads(path.read_text(encoding="utf-8"))["eventType"]
                for path in outbox_events
            }
            self.assertIn("skill.optimization.completed", event_types)

    def test_records_failure_event_without_hiding_original_error(self) -> None:
        candidate = load_candidate(
            FIXTURES / "candidate.json",
            FIXTURES / "initial-skill.md",
        )
        dataset = load_dataset(FIXTURES / "dataset.json")

        class FailingJudge:
            def evaluate(self, skill, task, result):
                del skill, task, result
                raise RuntimeError("provider failed token=top-secret")

        with tempfile.TemporaryDirectory() as directory:
            state_root = Path(directory)
            orchestrator = build_fake_orchestrator(state_root)
            orchestrator.judge = FailingJudge()

            with self.assertRaisesRegex(RuntimeError, "provider failed"):
                orchestrator.run(
                    candidate,
                    dataset,
                    experiment_id="mock-experiment-failed",
                )

            failure = load_json(
                state_root
                / "artifacts"
                / "mock-experiment-failed"
                / "experiment-failure.json"
            )
            self.assertEqual(failure["status"], "failed")
            self.assertNotIn("top-secret", failure["message"])

            events = [
                load_json(path)
                for path in (
                    state_root / "outbox" / "mock-experiment-failed"
                ).glob("*.json")
            ]
            failed_events = [
                event
                for event in events
                if event["eventType"] == "skill.optimization.failed"
            ]
            self.assertEqual(len(failed_events), 1)
            self.assertEqual(failed_events[0]["status"], "failed")
            self.assertNotIn(
                "top-secret",
                failed_events[0]["payload"]["message"],
            )


if __name__ == "__main__":
    unittest.main()
