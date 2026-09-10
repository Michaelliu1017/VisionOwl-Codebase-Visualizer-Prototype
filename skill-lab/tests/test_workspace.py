from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from skill_lab.workspace import ArchiveWorkspaceBuilder


def run_git(repository: Path, *arguments: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(repository), *arguments],
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


class WorkspaceTests(unittest.TestCase):
    def test_exports_only_base_commit_without_git_history(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory) / "repo"
            repository.mkdir()
            run_git(repository, "init")
            run_git(repository, "config", "user.email", "skill-lab@example.test")
            run_git(repository, "config", "user.name", "Skill Lab Test")

            source = repository / "module.txt"
            source.write_text("base version\n", encoding="utf-8")
            run_git(repository, "add", "module.txt")
            run_git(repository, "commit", "-m", "base")
            base_sha = run_git(repository, "rev-parse", "HEAD")

            source.write_text("future answer\n", encoding="utf-8")
            run_git(repository, "commit", "-am", "future")

            lease = ArchiveWorkspaceBuilder().build(repository, base_sha)
            workspace_path = lease.path
            with lease as workspace:
                self.assertEqual(
                    (workspace / "module.txt").read_text(encoding="utf-8"),
                    "base version\n",
                )
                self.assertFalse((workspace / ".git").exists())
                self.assertNotIn("future answer", (workspace / "module.txt").read_text())
            self.assertFalse(workspace_path.exists())


if __name__ == "__main__":
    unittest.main()

