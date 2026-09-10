from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from skill_lab.models import EvaluationTask, SkillVersion, content_hash, utc_now
from skill_lab.runners import (
    LocalQoderRunner,
    ProcessResult,
    QoderRunnerConfig,
    RunnerConfigurationError,
    _redact_process_result,
    _snapshot_tree,
)


def run_git(repository: Path, *arguments: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(repository), *arguments],
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


class LocalQoderRunnerTests(unittest.TestCase):
    def test_validates_numeric_execution_user(self) -> None:
        config = QoderRunnerConfig(
            repository=Path("."),
            execution_user="10001:10001",
        )

        self.assertEqual(config.execution_user, "10001:10001")

        with self.assertRaisesRegex(
            RunnerConfigurationError,
            "execution user must be a numeric uid:gid",
        ):
            QoderRunnerConfig(repository=Path("."), execution_user="visionowl")

    def test_redacts_runtime_credentials_before_artifact_persistence(self) -> None:
        result = _redact_process_result(
            ProcessResult(
                returncode=1,
                stdout="token=very-secret-token",
                stderr="failed with very-secret-token",
                duration_ms=1,
                metadata={"removed": True},
            ),
            ("very-secret-token",),
        )

        self.assertNotIn("very-secret-token", result.stdout + result.stderr)
        self.assertEqual(result.metadata, {"removed": True})

    def test_snapshot_records_symlink_without_reading_its_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outside = root.parent / f"outside-{root.name}.txt"
            outside.write_text("host secret must not be read", encoding="utf-8")
            try:
                (root / "leak.txt").symlink_to(outside)
                snapshot = _snapshot_tree(root, ignored_paths=())
            finally:
                outside.unlink(missing_ok=True)

        self.assertTrue(snapshot["leak.txt"].startswith(b"SYMLINK\x00"))
        self.assertNotIn(b"host secret", snapshot["leak.txt"])

    def test_executes_agent_then_injects_hidden_test_and_collects_diff(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository, base_sha = self._repository(root)
            hidden_root = root / "hidden"
            hidden_root.mkdir()
            (hidden_root / "check.py").write_text(
                """from pathlib import Path
value = Path('modules/demo/result.txt').read_text(encoding='utf-8')
raise SystemExit(0 if value == 'implemented\\n' else 1)
""",
                encoding="utf-8",
            )
            qoder = self._fake_qoder(root, write_outside=False)
            artifact_root = root / "artifacts"
            runtime_root = root / "runtime"
            runner = LocalQoderRunner(
                QoderRunnerConfig(
                    repository=repository,
                    qoder_binary=str(qoder),
                    artifact_root=artifact_root,
                    hidden_tests_root=hidden_root,
                    temporary_root=runtime_root,
                    timeout_seconds=5,
                    check_timeout_seconds=5,
                )
            )

            result = runner.execute(self._skill(), self._task(base_sha))

            self.assertEqual(result.provider, "qoder-local")
            self.assertEqual(result.changed_files, ("modules/demo/result.txt",))
            self.assertFalse(result.violations)
            self.assertTrue(all(check.passed for check in result.checks))
            self.assertIn("implemented", result.diff)
            self.assertNotIn(".skill-lab-hidden", result.diff)
            self.assertEqual(result.trace["missing_rules"], [])
            self.assertTrue(Path(result.trace["artifacts"]["diff"]).exists())
            self.assertTrue(runtime_root.is_dir())
            self.assertEqual(
                list(runtime_root.glob("visionowl-skill-lab-*/workspace")), []
            )

    def test_reports_changes_outside_allowed_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository, base_sha = self._repository(root)
            qoder = self._fake_qoder(root, write_outside=True)
            runner = LocalQoderRunner(
                QoderRunnerConfig(
                    repository=repository,
                    qoder_binary=str(qoder),
                    temporary_root=root,
                    timeout_seconds=5,
                    check_timeout_seconds=5,
                )
            )
            task = EvaluationTask(
                id="scope",
                requirement="implement demo",
                base_sha=base_sha,
                required_rules=("stay in scope",),
                critical_rules=("stay in scope",),
                allowed_paths=("modules/demo",),
            )

            result = runner.execute(self._skill(), task)

            self.assertIn("README.md", result.changed_files)
            self.assertTrue(
                any("outside allowed paths" in item for item in result.violations)
            )

    @staticmethod
    def _repository(root: Path) -> tuple[Path, str]:
        repository = root / "repo"
        repository.mkdir()
        run_git(repository, "init")
        run_git(repository, "config", "user.email", "skill-lab@example.test")
        run_git(repository, "config", "user.name", "Skill Lab Test")
        (repository / "README.md").write_text("base\n", encoding="utf-8")
        run_git(repository, "add", "README.md")
        run_git(repository, "commit", "-m", "base")
        return repository, run_git(repository, "rev-parse", "HEAD")

    @staticmethod
    def _fake_qoder(root: Path, *, write_outside: bool) -> Path:
        executable = root / ("fake-qoder-outside" if write_outside else "fake-qoder")
        executable.write_text(
            f"""#!{sys.executable}
import pathlib
import sys

args = sys.argv[1:]
workspace = pathlib.Path(args[args.index('-w') + 1])
attachment = pathlib.Path(args[args.index('--attachment') + 1])
prompt = attachment.read_text(encoding='utf-8')
if 'Candidate rule' not in prompt:
    raise SystemExit(12)
if (workspace / '.skill-lab-hidden').exists():
    raise SystemExit(13)
target = workspace / 'modules/demo/result.txt'
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text('implemented\\n', encoding='utf-8')
if {write_outside!r}:
    (workspace / 'README.md').write_text('changed outside\\n', encoding='utf-8')
print('{{"result":"done"}}')
""",
            encoding="utf-8",
        )
        executable.chmod(0o755)
        return executable

    @staticmethod
    def _skill() -> SkillVersion:
        content = "# Candidate\n\nCandidate rule\n"
        return SkillVersion(
            skill_id="candidate",
            version="0.1.0",
            content=content,
            checksum=content_hash(content),
            parent_version=None,
            created_at=utc_now(),
        )

    @staticmethod
    def _task(base_sha: str) -> EvaluationTask:
        return EvaluationTask(
            id="demo",
            requirement="implement demo",
            base_sha=base_sha,
            required_rules=("Candidate rule",),
            critical_rules=("Candidate rule",),
            allowed_paths=("modules/demo",),
            metadata={
                "runner": {
                    "hiddenFiles": [
                        {
                            "source": "check.py",
                            "target": ".skill-lab-hidden/check.py",
                        }
                    ],
                    "checks": [
                        {
                            "name": "hidden-demo-check",
                            "command": [sys.executable, ".skill-lab-hidden/check.py"],
                            "critical": True,
                            "rule": "Candidate rule",
                        }
                    ],
                }
            },
        )


if __name__ == "__main__":
    unittest.main()
