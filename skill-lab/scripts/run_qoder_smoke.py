from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Optional, Sequence


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from skill_lab.contracts import load_candidate, load_dataset
from skill_lab.docker_runner import DockerQoderRunner, DockerQoderRunnerConfig
from skill_lab.models import EvaluationTask, SkillVersion
from skill_lab.runners import LocalQoderRunner, QoderRunnerConfig
from skill_lab.serialization import dumps


def _fixture_root() -> Path:
    return ROOT / "tests" / "fixtures" / "visionowl"


def build_parser() -> argparse.ArgumentParser:
    fixtures = _fixture_root()
    parser = argparse.ArgumentParser(
        description="Run exactly one real Qoder Skill Lab evaluation task"
    )
    parser.add_argument(
        "--candidate",
        type=Path,
        default=fixtures / "candidate-qoder.json",
    )
    parser.add_argument(
        "--skill",
        type=Path,
        default=fixtures / "initial-skill.md",
    )
    parser.add_argument(
        "--dataset",
        type=Path,
        default=fixtures / "dataset-qoder.json",
    )
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--hidden-tests-root", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument(
        "--task-id",
        help="Defaults to the first development task",
    )
    parser.add_argument("--qoder-binary", default="qodercli")
    parser.add_argument("--qoder-model", default="Performance")
    parser.add_argument("--qoder-max-turns", type=int, default=25)
    parser.add_argument("--qoder-timeout-seconds", type=int, default=900)
    parser.add_argument("--check-timeout-seconds", type=int, default=120)
    parser.add_argument("--runner", choices=("local", "docker"), default="local")
    parser.add_argument("--docker-image")
    parser.add_argument("--docker-binary", default="docker")
    parser.add_argument("--docker-container-user", default="10001:10001")
    parser.add_argument("--allow-unpinned-docker-image", action="store_true")
    return parser


def _select_task(task_id: Optional[str], tasks: Sequence[EvaluationTask]) -> EvaluationTask:
    if task_id is None:
        return tasks[0]
    for task in tasks:
        if task.id == task_id:
            return task
    available = ", ".join(task.id for task in tasks)
    raise SystemExit(f"unknown task id {task_id!r}; available tasks: {available}")


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    candidate = load_candidate(args.candidate, args.skill)
    dataset = load_dataset(args.dataset)
    tasks = (*dataset.development_tasks, *dataset.validation_tasks)
    task = _select_task(args.task_id, tasks)

    args.state_dir.mkdir(parents=True, exist_ok=True)
    runner_config = QoderRunnerConfig(
        repository=args.repository,
        qoder_binary=args.qoder_binary,
        model=args.qoder_model,
        max_turns=args.qoder_max_turns,
        timeout_seconds=args.qoder_timeout_seconds,
        check_timeout_seconds=args.check_timeout_seconds,
        artifact_root=args.state_dir / "runner-artifacts",
        hidden_tests_root=args.hidden_tests_root,
        temporary_root=args.state_dir / "workspaces",
    )
    if args.runner == "docker":
        if not args.docker_image:
            raise SystemExit("--docker-image is required when --runner=docker")
        runner = DockerQoderRunner(
            runner_config,
            DockerQoderRunnerConfig(
                image=args.docker_image,
                docker_binary=args.docker_binary,
                qoder_binary=args.qoder_binary,
                container_user=args.docker_container_user,
                require_image_digest=not args.allow_unpinned_docker_image,
            ),
        )
    else:
        runner = LocalQoderRunner(runner_config)
    result = runner.execute(SkillVersion.from_candidate(candidate), task)
    output_path = args.state_dir / f"{task.id}-execution-result.json"
    output_path.write_text(dumps(result) + "\n", encoding="utf-8")

    print(dumps(result))
    print(f"\n单任务结果：{output_path}")
    print(f"Runner 产物：{args.state_dir / 'runner-artifacts'}")

    qoder_check = next((check for check in result.checks if check.name == "qoder-exit"), None)
    return 0 if qoder_check and qoder_check.passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
