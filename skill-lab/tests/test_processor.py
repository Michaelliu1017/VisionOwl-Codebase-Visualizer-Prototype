from __future__ import annotations

import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from skill_lab.bundles import build_zip, load_skill_bundle
from skill_lab.models import (
    ExperimentReport,
    ExperimentStatus,
    GateDecision,
    RoundReport,
    ScoreCard,
    SkillPatch,
    utc_now,
)
from skill_lab.processor import SkillLabProcessorConfig, SkillLabRunProcessor


def repository_archive(body: bytes) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("repo-root/src/value.txt", body)
    return output.getvalue()


class FakeCore:
    def __init__(self, bundle: bytes, base: str, head: str) -> None:
        self.bundle = bundle
        self.base = base
        self.head = head
        self.uploads: dict[str, bytes] = {}
        self.completed = None
        self.failed = None
        self.progress = []

    def get_command(self, run_id: str):
        return {
            "schemaVersion": "1.0",
            "runId": run_id,
            "status": "queued",
            "projectId": "project-1",
            "inputSkillVersionId": "11111111-1111-1111-1111-111111111111",
            "inputSkillDownloadPath": "/skill.zip",
            "repositorySnapshots": [
                {
                    "bindingId": "binding-1",
                    "repoFullName": "visionowl/example",
                    "commitSha": self.head,
                    "archiveDownloadPath": "/archive/{sha}",
                }
            ],
            "optimizationPolicy": {"maxRounds": 1},
            "artifactUploadPath": "/artifacts/{fileName}",
            "callbacks": {"progress": "/progress", "complete": "/complete"},
        }

    def download(self, path: str) -> bytes:
        if path == "/skill.zip":
            return self.bundle
        if path == f"/archive/{self.base}":
            return repository_archive(b"before\n")
        if path == f"/archive/{self.head}":
            return repository_archive(b"after\n")
        raise AssertionError(path)

    def update_progress(self, _command, **update) -> None:
        self.progress.append(update)

    def upload_artifact(self, _command, file_name: str, content: bytes):
        key = f"runs/run-1/{file_name}"
        self.uploads[key] = content
        return {"artifactKey": key}

    def complete(self, _command, payload) -> None:
        self.completed = payload

    def fail(self, _run_id: str, error: str) -> None:
        self.failed = error


class AcceptedProcessor(SkillLabRunProcessor):
    def _run_skill(self, *, state_root: Path, skill_content: str, **_kwargs):
        accepted = state_root / "accepted-skill.md"
        accepted.parent.mkdir(parents=True, exist_ok=True)
        accepted.write_text(skill_content + "\n- Verify the historical behavior.\n", encoding="utf-8")
        score = ScoreCard(90, 100, 100, 80, 80, (), ())
        return ExperimentReport(
            experiment_id="experiment-1",
            candidate_id="candidate-1",
            status=ExperimentStatus.COMPLETED,
            baseline_version="input-1",
            accepted_version="input-1-opt.1",
            baseline_development_score=score,
            baseline_validation_score=score,
            rounds=(
                RoundReport(
                    number=1,
                    candidate_version="input-1-opt.1",
                    patch=SkillPatch(("Verify the historical behavior.",), ("test",), ("task",)),
                    development_score=score,
                    validation_score=score,
                    decision=GateDecision.ACCEPTED,
                    note="accepted",
                ),
            ),
            started_at=utc_now(),
            finished_at=utc_now(),
            artifact_refs={"acceptedSkill": str(accepted)},
        )


class ProcessorTests(unittest.TestCase):
    def test_publishes_a_complete_bundle_after_an_accepted_skill(self) -> None:
        base, head = "a" * 40, "b" * 40
        dataset = {
            "id": "history-v1",
            "version": "1.0.0",
            "usable": True,
            "developmentTasks": [self._task("dev", base, head)],
            "validationTasks": [self._task("validation", base, head)],
        }
        manifest = {
            "schemaVersion": "1.0",
            "kind": "skills",
            "title": "Candidate Skills",
            "files": [
                {
                    "id": "skill-review",
                    "title": "Review",
                    "path": "skills/review/SKILL.md",
                    "artifactKey": "old/skill.md",
                    "mediaType": "text/markdown; charset=utf-8",
                }
            ],
        }
        bundle = build_zip(
            {
                "skills/review/SKILL.md": b"# Review\n",
                "evaluation/dataset.json": json.dumps(dataset).encode(),
            },
            json.dumps(manifest).encode(),
        )
        core = FakeCore(bundle, base, head)
        with tempfile.TemporaryDirectory() as directory:
            outcome = AcceptedProcessor(
                core,
                SkillLabProcessorConfig(
                    state_root=Path(directory),
                    runner_backend="local",
                    max_rounds=1,
                    max_skills=1,
                    max_development_tasks=1,
                    max_validation_tasks=1,
                ),
            ).process("run-1")

        self.assertEqual(outcome.decision, "accepted")
        self.assertIsNone(core.failed)
        self.assertEqual(core.completed["decision"], "accepted")
        output_key = core.completed["output"]["bundleArtifactKey"]
        output = load_skill_bundle(core.uploads[output_key])
        self.assertIn("Verify the historical behavior", output.skills()[0][1])
        self.assertGreaterEqual(len(core.progress), 3)

    @staticmethod
    def _task(task_id: str, base: str, head: str):
        return {
            "id": task_id,
            "requirement": "Update value",
            "baseSha": base,
            "requiredRules": ["update value"],
            "criticalRules": ["update value"],
            "allowedPaths": ["src/value.txt"],
            "forbiddenPaths": [".git"],
            "metadata": {
                "bindingId": "binding-1",
                "repoFullName": "visionowl/example",
                "headSha": head,
                "expectedChanges": [
                    {"path": "src/value.txt", "status": "modified", "previousPath": None}
                ],
                "runner": {"checks": [], "hiddenFiles": []},
            },
        }


if __name__ == "__main__":
    unittest.main()
