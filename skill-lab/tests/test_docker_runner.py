from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from skill_lab.docker_runner import (
    ContainerMount,
    ContainerSpec,
    DockerCliRuntime,
    DockerQoderRunner,
    DockerQoderRunnerConfig,
)
from skill_lab.models import EvaluationTask, SkillVersion, content_hash, utc_now
from skill_lab.runners import ProcessResult, QoderRunnerConfig, RunnerConfigurationError


def run_git(repository: Path, *arguments: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(repository), *arguments],
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


class FakeContainerRuntime:
    def __init__(self) -> None:
        self.images: tuple[str, ...] = ()
        self.specs: list[ContainerSpec] = []

    def ensure_ready(self, images) -> None:
        self.images = tuple(images)

    def run(self, spec: ContainerSpec) -> ProcessResult:
        self.specs.append(spec)
        workspace = next(
            mount.source for mount in spec.mounts if mount.target == "/workspace"
        )
        stage = spec.labels["visionowl.stage"]
        if stage == "agent":
            if (workspace / ".skill-lab-hidden").exists():
                raise AssertionError("hidden tests were visible to the agent container")
            prompt = next(
                mount
                for mount in spec.mounts
                if mount.target == "/run/visionowl/task-and-skill.md"
            )
            if not prompt.read_only or "Candidate rule" not in prompt.source.read_text(
                encoding="utf-8"
            ):
                raise AssertionError("candidate prompt was not mounted read-only")
            target = workspace / "modules/demo/result.txt"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("implemented\n", encoding="utf-8")
        else:
            hidden = workspace / ".skill-lab-hidden/check.py"
            if not hidden.is_file():
                raise AssertionError("hidden tests were not injected before checking")
            if spec.network != "none":
                raise AssertionError("hidden checks must not have network access")
        return ProcessResult(
            returncode=0,
            stdout="ok",
            stderr="",
            duration_ms=10,
            metadata={"containerName": spec.name, "removed": True},
        )


class DockerQoderRunnerTests(unittest.TestCase):
    def test_runs_agent_and_hidden_checks_in_separate_containers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository, base_sha = self._repository(root)
            hidden_root = root / "hidden"
            hidden_root.mkdir()
            (hidden_root / "check.py").write_text("raise SystemExit(0)\n", encoding="utf-8")
            runtime_root = root / "runtime"
            runtime = FakeContainerRuntime()
            runner = DockerQoderRunner(
                QoderRunnerConfig(
                    repository=repository,
                    artifact_root=root / "artifacts",
                    hidden_tests_root=hidden_root,
                    temporary_root=runtime_root,
                    timeout_seconds=5,
                    check_timeout_seconds=5,
                ),
                DockerQoderRunnerConfig(
                    image="visionowl-skill-lab:test",
                    container_user=(
                        "10001:10001"
                        if os.getuid() == 0
                        else f"{os.getuid()}:{os.getgid()}"
                    ),
                    require_image_digest=False,
                    require_qoder_token=False,
                ),
                runtime=runtime,
            )

            result = runner.execute(self._skill(), self._task(base_sha))

            self.assertEqual(result.provider, "qoder-docker")
            self.assertEqual(result.changed_files, ("modules/demo/result.txt",))
            self.assertTrue(all(check.passed for check in result.checks))
            self.assertEqual(len(runtime.specs), 2)
            self.assertEqual(runtime.specs[0].labels["visionowl.stage"], "agent")
            self.assertEqual(runtime.specs[0].network, "bridge")
            self.assertEqual(runtime.specs[1].labels["visionowl.stage"], "hidden-check")
            self.assertEqual(runtime.specs[1].network, "none")
            self.assertEqual(runtime.images, ("visionowl-skill-lab:test",) * 2)
            self.assertTrue(result.trace["runtime"]["removed"])
            self.assertEqual(list(runtime_root.glob("visionowl-skill-lab-*/workspace")), [])

    def test_docker_command_hides_secret_values_and_enforces_isolation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = ContainerSpec(
                name="visionowl-test",
                image="runner:test",
                command=("qodercli", "--version"),
                mounts=(ContainerMount(root, "/workspace"),),
                environment={"QODER_PERSONAL_ACCESS_TOKEN": "do-not-put-in-argv"},
                network="bridge",
                user="1000:1000",
            )

            command = DockerCliRuntime.build_run_command("docker", spec)
            rendered = " ".join(command)

            self.assertNotIn("do-not-put-in-argv", rendered)
            self.assertIn("QODER_PERSONAL_ACCESS_TOKEN", command)
            self.assertIn("--read-only", command)
            self.assertIn("no-new-privileges:true", command)
            self.assertIn("ALL", command)
            self.assertIn("--pids-limit", command)
            self.assertIn("--memory", command)
            self.assertIn("--cpus", command)

    def test_runtime_force_removes_a_timed_out_container(self) -> None:
        calls: list[list[str]] = []

        def execute(command, **_kwargs):
            value = list(command)
            calls.append(value)
            if len(value) > 1 and value[1] == "run":
                return ProcessResult(-15, "", "", 50, timed_out=True)
            if len(value) > 1 and value[1] == "inspect":
                return ProcessResult(
                    0,
                    json.dumps({"Status": "running", "Running": True}),
                    "",
                    1,
                )
            return ProcessResult(0, "", "", 1)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = DockerCliRuntime(sys.executable, process_executor=execute)
            result = runtime.run(
                ContainerSpec(
                    name="visionowl-timeout",
                    image="runner:test",
                    command=("qodercli",),
                    mounts=(ContainerMount(root, "/workspace"),),
                    environment={},
                )
            )

        self.assertTrue(result.timed_out)
        self.assertTrue(result.metadata["removed"])
        self.assertTrue(any(call[1:4] == ["rm", "-f", "visionowl-timeout"] for call in calls))

    def test_production_configuration_requires_digest_pinning(self) -> None:
        with self.assertRaises(RunnerConfigurationError):
            DockerQoderRunnerConfig(image="visionowl-skill-lab:latest")
        DockerQoderRunnerConfig(image="sha256:" + ("a" * 64))

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
                            "command": ["python3", ".skill-lab-hidden/check.py"],
                            "critical": True,
                            "rule": "Candidate rule",
                        }
                    ],
                }
            },
        )


if __name__ == "__main__":
    unittest.main()
