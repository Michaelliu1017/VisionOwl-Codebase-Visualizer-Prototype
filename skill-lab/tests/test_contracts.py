from __future__ import annotations

import json
import unittest
from pathlib import Path

from skill_lab.contracts import load_candidate, load_dataset


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures" / "visionowl"


class ContractTests(unittest.TestCase):
    def test_loads_candidate_and_dataset(self) -> None:
        candidate = load_candidate(
            FIXTURES / "candidate.json",
            FIXTURES / "initial-skill.md",
        )
        dataset = load_dataset(FIXTURES / "dataset.json")

        self.assertEqual(candidate.dataset_id, dataset.id)
        self.assertEqual(len(dataset.development_tasks), 2)
        self.assertEqual(len(dataset.validation_tasks), 2)

    def test_loads_real_qoder_dataset(self) -> None:
        candidate = load_candidate(
            FIXTURES / "candidate-qoder.json",
            FIXTURES / "initial-skill.md",
        )
        dataset = load_dataset(FIXTURES / "dataset-qoder.json")

        self.assertEqual(candidate.dataset_id, dataset.id)
        self.assertEqual(len(dataset.development_tasks), 1)
        self.assertEqual(len(dataset.validation_tasks), 1)
        runner_metadata = dataset.development_tasks[0].metadata["runner"]
        self.assertEqual(len(runner_metadata["checks"]), 3)
        self.assertEqual(len(candidate.checksum), 64)

    def test_json_schema_files_are_valid_json(self) -> None:
        for path in (ROOT / "contracts").glob("*.json"):
            with self.subTest(path=path.name):
                with path.open("r", encoding="utf-8") as handle:
                    parsed = json.load(handle)
                self.assertIn("$schema", parsed)
                self.assertIn("$id", parsed)


if __name__ == "__main__":
    unittest.main()
