from __future__ import annotations

import argparse
import tempfile
from pathlib import Path
from typing import Optional, Sequence

from .contracts import load_candidate, load_dataset
from .serialization import dumps
from .service import build_fake_orchestrator, build_qoder_orchestrator


def _default_fixture_root() -> Path:
    return Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "visionowl"


def build_parser() -> argparse.ArgumentParser:
    fixture_root = _default_fixture_root()
    parser = argparse.ArgumentParser(description="VisionOwl Skill Lab development CLI")
    parser.add_argument(
        "--candidate",
        type=Path,
        default=fixture_root / "candidate.json",
    )
    parser.add_argument(
        "--skill",
        type=Path,
        default=fixture_root / "initial-skill.md",
    )
    parser.add_argument(
        "--dataset",
        type=Path,
        default=fixture_root / "dataset.json",
    )
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument(
        "--runner",
        choices=("fake", "qoder", "docker"),
        default="fake",
        help="fake replays the demo; qoder runs locally; docker uses isolated containers",
    )
    parser.add_argument("--repository", type=Path)
    parser.add_argument("--qoder-binary", default="qodercli")
    parser.add_argument("--qoder-model", default="Performance")
    parser.add_argument("--qoder-max-turns", type=int, default=25)
    parser.add_argument("--qoder-timeout-seconds", type=int, default=900)
    parser.add_argument("--check-timeout-seconds", type=int, default=120)
    parser.add_argument("--hidden-tests-root", type=Path)
    parser.add_argument("--max-rounds", type=int, default=2)
    parser.add_argument("--docker-image")
    parser.add_argument("--docker-check-image")
    parser.add_argument("--docker-binary", default="docker")
    parser.add_argument("--docker-container-user", default="10001:10001")
    parser.add_argument(
        "--allow-unpinned-docker-image",
        action="store_true",
        help="development only; production images must use @sha256 digests",
    )
    return parser


def _build_orchestrator(args: argparse.Namespace, state_dir: Path):
    if args.runner == "fake":
        return build_fake_orchestrator(state_dir)
    if args.repository is None:
        raise SystemExit("--repository is required for real runners")
    if args.runner == "docker" and not args.docker_image:
        raise SystemExit("--docker-image is required when --runner=docker")
    return build_qoder_orchestrator(
        state_dir,
        repository=args.repository,
        qoder_binary=args.qoder_binary,
        model=args.qoder_model,
        max_turns=args.qoder_max_turns,
        timeout_seconds=args.qoder_timeout_seconds,
        check_timeout_seconds=args.check_timeout_seconds,
        hidden_tests_root=args.hidden_tests_root,
        max_rounds=args.max_rounds,
        runner_backend="docker" if args.runner == "docker" else "local",
        docker_image=args.docker_image,
        docker_check_image=args.docker_check_image,
        docker_binary=args.docker_binary,
        docker_container_user=args.docker_container_user,
        docker_require_image_digest=not args.allow_unpinned_docker_image,
    )


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    candidate = load_candidate(args.candidate, args.skill)
    dataset = load_dataset(args.dataset)

    if args.state_dir:
        state_dir = args.state_dir
        state_dir.mkdir(parents=True, exist_ok=True)
        report = _build_orchestrator(args, state_dir).run(candidate, dataset)
        print(dumps(report))
        print(f"\n实验产物：{state_dir}")
        return 0

    with tempfile.TemporaryDirectory(prefix="visionowl-skill-lab-demo-") as directory:
        state_dir = Path(directory)
        report = _build_orchestrator(args, state_dir).run(candidate, dataset)
        print(dumps(report))
        print(f"\n临时实验产物：{state_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
