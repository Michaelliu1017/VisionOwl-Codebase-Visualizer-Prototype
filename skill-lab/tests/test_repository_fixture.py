from __future__ import annotations

import io
import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

from skill_lab.repository_fixture import EvaluationRepositoryBuilder


def archive(files: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as value:
        for path, content in files.items():
            value.writestr(f"repo-root/{path}", content)
    return output.getvalue()


class Downloader:
    def __init__(self, values: dict[str, bytes]) -> None:
        self.values = values

    def download(self, path: str) -> bytes:
        return self.values[path]


class RepositoryFixtureTests(unittest.TestCase):
    def test_rebuilds_base_commits_and_keeps_golden_files_hidden(self) -> None:
        base = "a" * 40
        head = "b" * 40
        command = {
            "repositorySnapshots": [
                {
                    "bindingId": "binding-1",
                    "archiveDownloadPath": "/archives/{sha}",
                }
            ]
        }
        task = {
            "id": "task-1",
            "requirement": "Change the greeting",
            "baseSha": base,
            "requiredRules": ["change greeting"],
            "criticalRules": ["change greeting"],
            "allowedPaths": ["src/message.txt"],
            "forbiddenPaths": [".git"],
            "metadata": {
                "bindingId": "binding-1",
                "headSha": head,
                "expectedChanges": [
                    {"path": "src/message.txt", "status": "modified", "previousPath": None}
                ],
                "runner": {"checks": [], "hiddenFiles": []},
            },
        }
        dataset = {
            "id": "history-v1",
            "version": "1.0.0",
            "developmentTasks": [task],
            "validationTasks": [{**task, "id": "task-2"}],
        }

        with tempfile.TemporaryDirectory() as directory:
            prepared = EvaluationRepositoryBuilder(
                Downloader(
                    {
                        f"/archives/{base}": archive({"src/message.txt": b"hello\n"}),
                        f"/archives/{head}": archive({"src/message.txt": b"hello team\n"}),
                    }
                ),
                root=Path(directory),
            ).prepare(command, dataset)

            local_sha = prepared.dataset.development_tasks[0].base_sha
            subprocess.run(
                ["git", "-C", str(prepared.repository), "cat-file", "-e", f"{local_sha}^{{commit}}"],
                check=True,
            )
            self.assertNotEqual(local_sha, base)
            self.assertFalse((prepared.repository / ".skill-lab-hidden").exists())
            runner = prepared.dataset.development_tasks[0].metadata["runner"]
            targets = {item["target"] for item in runner["hiddenFiles"]}
            self.assertIn(".skill-lab-hidden/task-1/golden_check.py", targets)
            self.assertTrue(
                (prepared.hidden_tests_root / "task-1/gold/src/message.txt").is_file()
            )


if __name__ == "__main__":
    unittest.main()
