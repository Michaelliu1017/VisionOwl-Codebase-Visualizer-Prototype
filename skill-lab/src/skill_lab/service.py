from __future__ import annotations

from pathlib import Path
from typing import Optional

from .artifacts import LocalArtifactStore
from .docker_runner import DockerQoderRunner, DockerQoderRunnerConfig
from .evaluator import DeterministicEvaluator
from .events import FileOutbox
from .fakes import FakeJudge, FakeOptimizer, FakeRunner
from .gates import QualityGate
from .judges import BailianJudgeConfig, DeepEvalJudge
from .optimizers import SkillOptConfig, SkillOptOptimizer
from .orchestrator import ExperimentOrchestrator
from .patches import PatchValidator
from .ports import Optimizer, SemanticJudge
from .registry import FileSkillRegistry
from .runners import LocalQoderRunner, QoderRunnerConfig


def build_fake_orchestrator(state_root: Path) -> ExperimentOrchestrator:
    state_root = state_root.resolve()
    return ExperimentOrchestrator(
        runner=FakeRunner(),
        judge=FakeJudge(),
        optimizer=FakeOptimizer(max_changes=3),
        evaluator=DeterministicEvaluator(),
        patch_validator=PatchValidator(max_changes=3),
        quality_gate=QualityGate(),
        registry=FileSkillRegistry(state_root / "registry"),
        artifact_store=LocalArtifactStore(state_root / "artifacts"),
        outbox=FileOutbox(state_root / "outbox"),
        max_rounds=5,
    )


def build_qoder_orchestrator(
    state_root: Path,
    *,
    repository: Path,
    qoder_binary: str = "qodercli",
    model: str = "Performance",
    max_turns: int = 25,
    timeout_seconds: int = 900,
    check_timeout_seconds: int = 120,
    hidden_tests_root: Optional[Path] = None,
    max_rounds: int = 2,
    semantic_judge: Optional[SemanticJudge] = None,
    optimizer: Optional[Optimizer] = None,
    runner_backend: str = "local",
    docker_image: Optional[str] = None,
    docker_check_image: Optional[str] = None,
    docker_binary: str = "docker",
    docker_container_user: str = "10001:10001",
    docker_require_image_digest: bool = True,
    docker_require_qoder_token: bool = True,
    local_execution_user: Optional[str] = None,
) -> ExperimentOrchestrator:
    """Build the real loop with Qoder, DeepEval/Bailian and SkillOpt/Bailian.

    The fake judge is never selected implicitly. Tests may inject an explicit
    semantic_judge; normal Qoder runs require Bailian configuration from the
    environment and fail before spending Qoder credits when it is unavailable.
    """

    state_root = state_root.resolve()
    runner_config = QoderRunnerConfig(
        repository=repository,
        qoder_binary=qoder_binary,
        model=model,
        max_turns=max_turns,
        timeout_seconds=timeout_seconds,
        check_timeout_seconds=check_timeout_seconds,
        artifact_root=state_root / "runner-artifacts",
        hidden_tests_root=hidden_tests_root,
        temporary_root=state_root / "workspaces",
        execution_user=local_execution_user,
    )
    if runner_backend == "local":
        runner = LocalQoderRunner(runner_config)
    elif runner_backend == "docker":
        if not docker_image:
            raise ValueError("docker_image is required for runner_backend=docker")
        runner = DockerQoderRunner(
            runner_config,
            DockerQoderRunnerConfig(
                image=docker_image,
                check_image=docker_check_image,
                docker_binary=docker_binary,
                qoder_binary=qoder_binary,
                container_user=docker_container_user,
                require_image_digest=docker_require_image_digest,
                require_qoder_token=docker_require_qoder_token,
            ),
        )
    else:
        raise ValueError(f"unsupported runner backend: {runner_backend}")
    (state_root / "workspaces").mkdir(parents=True, exist_ok=True)
    judge = semantic_judge or DeepEvalJudge(BailianJudgeConfig.from_env())
    active_optimizer = optimizer or SkillOptOptimizer(
        SkillOptConfig.from_env(),
        work_root=state_root / "optimizer-artifacts",
    )
    return ExperimentOrchestrator(
        runner=runner,
        judge=judge,
        optimizer=active_optimizer,
        evaluator=DeterministicEvaluator(),
        patch_validator=PatchValidator(max_changes=3),
        quality_gate=QualityGate(),
        registry=FileSkillRegistry(state_root / "registry"),
        artifact_store=LocalArtifactStore(state_root / "artifacts"),
        outbox=FileOutbox(state_root / "outbox"),
        max_rounds=max_rounds,
    )
