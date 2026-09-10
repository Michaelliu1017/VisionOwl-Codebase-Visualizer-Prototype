from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Mapping, MutableMapping, Sequence

from .bundles import SkillBundle, build_zip, load_skill_bundle, sha256
from .contracts import candidate_from_dict
from .core_client import CoreClient
from .models import EvaluationDataset, ExperimentReport, ExperimentStatus
from .repository_fixture import EvaluationRepositoryBuilder
from .serialization import to_jsonable
from .service import build_qoder_orchestrator


_TERMINAL_STATUSES = {"succeeded", "rejected", "failed"}
_SECRET = re.compile(
    r"(?i)((?:api[_-]?key|token|secret|password|credential)\s*[=:]\s*)[^\s\"']+"
)


@dataclass(frozen=True)
class SkillLabProcessorConfig:
    state_root: Path
    runner_backend: str = "local"
    runner_image: str = ""
    check_image: str | None = None
    qoder_binary: str = "qodercli"
    qoder_model: str = "Performance"
    qoder_max_turns: int = 25
    qoder_timeout_seconds: int = 900
    check_timeout_seconds: int = 120
    max_rounds: int = 2
    max_skills: int = 3
    max_development_tasks: int = 2
    max_validation_tasks: int = 1
    docker_binary: str = "docker"
    docker_container_user: str = "10001:10001"
    local_execution_user: str = "10001:10001"

    def __post_init__(self) -> None:
        if self.runner_backend not in {"local", "docker"}:
            raise ValueError("SKILLLAB_RUNNER_BACKEND must be local or docker")
        if self.runner_backend == "docker" and not self.runner_image.strip():
            raise ValueError("SKILLLAB_RUNNER_IMAGE is required for the docker backend")
        if min(
            self.qoder_max_turns,
            self.qoder_timeout_seconds,
            self.check_timeout_seconds,
            self.max_rounds,
            self.max_skills,
            self.max_development_tasks,
            self.max_validation_tasks,
        ) < 1:
            raise ValueError("Skill Lab processor limits must be positive")

    @classmethod
    def from_env(cls) -> "SkillLabProcessorConfig":
        return cls(
            state_root=Path(os.environ.get("SKILLLAB_STATE_ROOT", "/data/skill-lab")),
            runner_backend=os.environ.get("SKILLLAB_RUNNER_BACKEND", "local"),
            runner_image=os.environ.get("SKILLLAB_RUNNER_IMAGE", ""),
            check_image=os.environ.get("SKILLLAB_CHECK_IMAGE") or None,
            qoder_binary=os.environ.get("SKILLLAB_QODER_BINARY", "qodercli"),
            qoder_model=os.environ.get("SKILLLAB_QODER_MODEL", "Performance"),
            qoder_max_turns=_int_env("SKILLLAB_QODER_MAX_TURNS", 25),
            qoder_timeout_seconds=_int_env("SKILLLAB_QODER_TIMEOUT_SECONDS", 900),
            check_timeout_seconds=_int_env("SKILLLAB_CHECK_TIMEOUT_SECONDS", 120),
            max_rounds=_int_env("SKILLLAB_WORKER_MAX_ROUNDS", 2),
            max_skills=_int_env("SKILLLAB_MAX_SKILLS", 3),
            max_development_tasks=_int_env("SKILLLAB_MAX_DEVELOPMENT_TASKS", 2),
            max_validation_tasks=_int_env("SKILLLAB_MAX_VALIDATION_TASKS", 1),
            docker_binary=os.environ.get("SKILLLAB_DOCKER_BINARY", "docker"),
            docker_container_user=os.environ.get(
                "SKILLLAB_DOCKER_CONTAINER_USER", "10001:10001"
            ),
            local_execution_user=os.environ.get(
                "SKILLLAB_LOCAL_EXECUTION_USER", "10001:10001"
            ),
        )


@dataclass(frozen=True)
class ProcessOutcome:
    run_id: str
    decision: str
    accepted_skills: int
    skipped: bool = False


class SkillLabRunProcessor:
    """Turns one Core command into a reproducible Skill evaluation run."""

    def __init__(self, core: CoreClient, config: SkillLabProcessorConfig) -> None:
        self.core = core
        self.config = config
        self.config.state_root.mkdir(parents=True, exist_ok=True)

    def process(self, run_id: str) -> ProcessOutcome:
        command = self.core.get_command(run_id)
        status = str(command.get("status") or "")
        if status in _TERMINAL_STATUSES:
            return ProcessOutcome(run_id, status, 0, skipped=True)

        run_root = self.config.state_root / _safe_segment(run_id)
        if run_root.exists():
            shutil.rmtree(run_root)
        run_root.mkdir(parents=True)

        try:
            return self._process(command, run_root)
        except Exception as error:
            message = _safe_error(error)
            self.core.fail(run_id, message)
            return ProcessOutcome(run_id, "failed", 0)

    def _process(
        self,
        command: Mapping[str, Any],
        run_root: Path,
    ) -> ProcessOutcome:
        run_id = _required_string(command, "runId")
        project_id = _required_string(command, "projectId")
        self.core.update_progress(
            command,
            status="evaluating",
            progress=5,
            stage="loading-input",
            note="正在校验候选 Skill 与历史评测集",
        )

        bundle = load_skill_bundle(
            self.core.download(_required_string(command, "inputSkillDownloadPath"))
        )
        dataset_data = _bounded_dataset(bundle.evaluation_dataset(), self.config)
        prepared = EvaluationRepositoryBuilder(
            self.core,
            root=run_root / "evaluation",
        ).prepare(command, dataset_data)
        skills = bundle.skills()[: self.config.max_skills]
        if not skills:
            raise ValueError("Skills bundle contains no optimizable SKILL.md")

        self.core.update_progress(
            command,
            status="evaluating",
            progress=18,
            stage="replaying-history",
            note=(
                f"已重建 {len(prepared.dataset.development_tasks)} 条开发集和 "
                f"{len(prepared.dataset.validation_tasks)} 条验证集任务"
            ),
        )

        output_files: MutableMapping[str, bytes] = dict(bundle.files)
        reports: list[Dict[str, Any]] = []
        diffs: list[str] = []
        accepted = 0
        for index, (path, content) in enumerate(skills, start=1):
            progress = 20 + int(((index - 1) / len(skills)) * 62)
            self.core.update_progress(
                command,
                status="optimizing",
                progress=progress,
                stage="optimizing-skill",
                note=f"正在评测并优化 {path}（{index}/{len(skills)}）",
            )
            report = self._run_skill(
                command=command,
                bundle=bundle,
                dataset=prepared.dataset,
                repository=prepared.repository,
                hidden_tests_root=prepared.hidden_tests_root,
                skill_path=path,
                skill_content=content,
                state_root=run_root / "experiments" / f"{index:02d}-{_path_hash(path)}",
            )
            accepted_content = _accepted_content(report)
            if accepted_content is not None and accepted_content != content:
                output_files[path] = accepted_content.encode("utf-8")
                accepted += 1
                diffs.append(_skill_diff(path, content, accepted_content))
            reports.append(_public_report(path, report))

        self.core.update_progress(
            command,
            status="validating",
            progress=88,
            stage="publishing-result",
            note="评测结束，正在生成报告并校验输出资产",
        )
        aggregate = _aggregate_report(
            run_id=run_id,
            input_version_id=_required_string(command, "inputSkillVersionId"),
            dataset=prepared.dataset,
            reports=reports,
            accepted=accepted,
            total_bundle_skills=len(bundle.skills()),
            evaluated_skills=len(skills),
        )
        report_receipt = self.core.upload_artifact(
            command,
            "skill-lab-report.json",
            (json.dumps(aggregate, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
        )
        diff_content = "\n".join(diffs) or "No Skill patch passed the validation gate.\n"
        diff_receipt = self.core.upload_artifact(
            command,
            "skill-lab.diff",
            diff_content.encode("utf-8"),
        )

        scores = _aggregate_scores(reports, accepted)
        if accepted == 0:
            self.core.complete(
                command,
                {
                    "decision": "rejected",
                    "scores": scores,
                    "reportArtifactKey": report_receipt["artifactKey"],
                    "diffArtifactKey": diff_receipt["artifactKey"],
                    "note": "候选 Skill 未在独立验证集上取得可接受提升，保留当前发布版本",
                },
            )
            return ProcessOutcome(run_id, "rejected", 0)

        output = self._publish_bundle(
            command,
            bundle,
            output_files,
            accepted=accepted,
            evaluated=len(skills),
        )
        self.core.complete(
            command,
            {
                "decision": "accepted",
                "scores": scores,
                "reportArtifactKey": report_receipt["artifactKey"],
                "diffArtifactKey": diff_receipt["artifactKey"],
                "output": output,
                "note": f"{accepted} 个 Skill 通过独立验证集，已发布新的完整 Skills 版本",
            },
        )
        return ProcessOutcome(run_id, "accepted", accepted)

    def _run_skill(
        self,
        *,
        command: Mapping[str, Any],
        bundle: SkillBundle,
        dataset: EvaluationDataset,
        repository: Path,
        hidden_tests_root: Path,
        skill_path: str,
        skill_content: str,
        state_root: Path,
    ) -> ExperimentReport:
        snapshot = _first_mapping(command.get("repositorySnapshots"), "repositorySnapshots")
        first_task = dataset.development_tasks[0]
        metadata = first_task.metadata
        policy = command.get("optimizationPolicy")
        policy_rounds = int(policy.get("maxRounds", self.config.max_rounds)) \
            if isinstance(policy, Mapping) else self.config.max_rounds
        candidate = candidate_from_dict(
            {
                "candidateSkillId": f"{_path_hash(skill_path)}-{_required_string(command, 'inputSkillVersionId')[:8]}",
                "projectId": _required_string(command, "projectId"),
                "candidateVersion": f"input-{_required_string(command, 'inputSkillVersionId')[:12]}",
                "sourceRepository": str(
                    metadata.get("repoFullName") or snapshot.get("repoFullName") or "unknown"
                ),
                "sourceCommitSha": str(
                    metadata.get("headSha") or snapshot.get("commitSha") or first_task.base_sha
                ),
                "datasetId": dataset.id,
                "targetProfile": {
                    "skillPath": skill_path,
                    "bundleTitle": bundle.manifest.get("title"),
                },
            },
            content=skill_content,
        )
        orchestrator = build_qoder_orchestrator(
            state_root,
            repository=repository,
            qoder_binary=self.config.qoder_binary,
            model=self.config.qoder_model,
            max_turns=self.config.qoder_max_turns,
            timeout_seconds=self.config.qoder_timeout_seconds,
            check_timeout_seconds=self.config.check_timeout_seconds,
            hidden_tests_root=hidden_tests_root,
            max_rounds=min(max(1, policy_rounds), self.config.max_rounds),
            runner_backend=self.config.runner_backend,
            docker_image=self.config.runner_image or None,
            docker_check_image=self.config.check_image,
            docker_binary=self.config.docker_binary,
            docker_container_user=self.config.docker_container_user,
            local_execution_user=(
                self.config.local_execution_user
                if self.config.runner_backend == "local"
                else None
            ),
        )
        return orchestrator.run(candidate, dataset)

    def _publish_bundle(
        self,
        command: Mapping[str, Any],
        bundle: SkillBundle,
        files: Mapping[str, bytes],
        *,
        accepted: int,
        evaluated: int,
    ) -> Mapping[str, Any]:
        existing = {
            str(item.get("path")): item
            for item in bundle.manifest.get("files", [])
            if isinstance(item, Mapping) and item.get("path")
        }
        manifest_files = []
        for path, content in sorted(files.items()):
            receipt = self.core.upload_artifact(
                command,
                f"skills-file-{_path_hash(path)}{Path(path).suffix or '.bin'}",
                content,
            )
            source = existing.get(path, {})
            manifest_files.append(
                {
                    "id": str(source.get("id") or f"file-{_path_hash(path)}"),
                    "title": str(source.get("title") or Path(path).stem),
                    "path": path,
                    "artifactKey": receipt["artifactKey"],
                    "mediaType": str(source.get("mediaType") or _media_type(path)),
                    "size": len(content),
                    "sha256": sha256(content),
                }
            )
        manifest = {
            "schemaVersion": "1.0",
            "kind": "skills",
            "title": str(bundle.manifest.get("title") or "VisionOwl Optimized Skills"),
            "files": manifest_files,
        }
        manifest_content = (
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
        ).encode("utf-8")
        archive = build_zip(files, manifest_content)
        manifest_receipt = self.core.upload_artifact(
            command, "skills-optimized-manifest.json", manifest_content
        )
        bundle_receipt = self.core.upload_artifact(
            command, "skills-optimized-bundle.zip", archive
        )
        return {
            "kind": "skills",
            "bundleArtifactKey": bundle_receipt["artifactKey"],
            "manifestArtifactKey": manifest_receipt["artifactKey"],
            "checksum": sha256(archive),
            "summary": {
                "files": len(files),
                "bytes": sum(len(content) for content in files.values()),
                "evaluatedSkills": evaluated,
                "optimizedSkills": accepted,
                "optimizer": "microsoft-skillopt",
                "judge": "deepeval-bailian",
                "runner": (
                    "qoder-local-isolated"
                    if self.config.runner_backend == "local"
                    else "qoder-docker"
                ),
            },
        }


def _bounded_dataset(
    value: Mapping[str, Any],
    config: SkillLabProcessorConfig,
) -> Mapping[str, Any]:
    result = json.loads(json.dumps(value))
    development = result.get("developmentTasks")
    validation = result.get("validationTasks")
    if not isinstance(development, list) or not isinstance(validation, list):
        raise ValueError("evaluation dataset needs developmentTasks and validationTasks")
    result["developmentTasks"] = development[: config.max_development_tasks]
    result["validationTasks"] = validation[: config.max_validation_tasks]
    return result


def _accepted_content(report: ExperimentReport) -> str | None:
    if report.status != ExperimentStatus.COMPLETED or not report.accepted_version:
        return None
    path = report.artifact_refs.get("acceptedSkill")
    if not path:
        raise ValueError("accepted experiment is missing acceptedSkill artifact")
    return Path(path).read_text(encoding="utf-8")


def _public_report(path: str, report: ExperimentReport) -> Dict[str, Any]:
    value = to_jsonable(report)
    assert isinstance(value, dict)
    value["skillPath"] = path
    value["artifact_refs"] = {
        key: Path(str(item)).name for key, item in report.artifact_refs.items()
    }
    return value


def _aggregate_report(
    *,
    run_id: str,
    input_version_id: str,
    dataset: EvaluationDataset,
    reports: Sequence[Mapping[str, Any]],
    accepted: int,
    total_bundle_skills: int,
    evaluated_skills: int,
) -> Mapping[str, Any]:
    return {
        "schemaVersion": "visionowl-skill-lab-report.v1",
        "runId": run_id,
        "inputSkillVersionId": input_version_id,
        "datasetId": dataset.id,
        "developmentTasks": len(dataset.development_tasks),
        "validationTasks": len(dataset.validation_tasks),
        "totalBundleSkills": total_bundle_skills,
        "evaluatedSkills": evaluated_skills,
        "acceptedSkills": accepted,
        "decision": "accepted" if accepted else "rejected",
        "experiments": list(reports),
    }


def _aggregate_scores(
    reports: Sequence[Mapping[str, Any]], accepted: int
) -> Mapping[str, Any]:
    baseline = [
        float(item["baseline_validation_score"]["total"])
        for item in reports
        if isinstance(item.get("baseline_validation_score"), Mapping)
    ]
    final = []
    for item in reports:
        rounds = item.get("rounds")
        if isinstance(rounds, list) and rounds:
            last = rounds[-1]
            score = last.get("validation_score") or last.get("development_score")
            if isinstance(score, Mapping):
                final.append(float(score.get("total", 0)))
                continue
        score = item.get("baseline_validation_score")
        if isinstance(score, Mapping):
            final.append(float(score.get("total", 0)))
    return {
        "baselineAverage": round(sum(baseline) / len(baseline), 2) if baseline else 0,
        "finalAverage": round(sum(final) / len(final), 2) if final else 0,
        "acceptedSkills": accepted,
        "evaluatedSkills": len(reports),
    }


def _skill_diff(path: str, before: str, after: str) -> str:
    return "".join(
        difflib.unified_diff(
            before.splitlines(keepends=True),
            after.splitlines(keepends=True),
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
        )
    )


def _first_mapping(value: Any, name: str) -> Mapping[str, Any]:
    if not isinstance(value, list) or not value or not isinstance(value[0], Mapping):
        raise ValueError(f"{name} must contain at least one item")
    return value[0]


def _required_string(value: Mapping[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result:
        raise ValueError(f"Skill Lab command field {key} must be a string")
    return result


def _path_hash(path: str) -> str:
    return hashlib.sha256(path.encode("utf-8")).hexdigest()[:20]


def _safe_segment(value: str) -> str:
    result = "".join(
        character if character.isalnum() or character in "._-" else "_"
        for character in value
    )
    return result[:120] or "run"


def _media_type(path: str) -> str:
    return "application/json; charset=utf-8" if path.endswith(".json") else "text/markdown; charset=utf-8"


def _safe_error(error: Exception) -> str:
    value = str(error).replace(str(Path.home()), "$HOME")
    value = _SECRET.sub(r"\1[REDACTED]", value)
    return f"{type(error).__name__}: {value}"[:2000]


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error
