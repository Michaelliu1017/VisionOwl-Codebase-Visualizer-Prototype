from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from .models import (
    EvaluationDataset,
    EvaluationTask,
    SkillCandidate,
    tuple_of_strings,
)
from .serialization import load_json


def candidate_from_dict(data: Mapping[str, Any], *, content: str) -> SkillCandidate:
    return SkillCandidate(
        id=str(data["candidateSkillId"]),
        project_id=str(data["projectId"]),
        version=str(data["candidateVersion"]),
        content=content,
        checksum=str(data.get("checksum", "")),
        source_repository=str(data["sourceRepository"]),
        source_commit_sha=str(data["sourceCommitSha"]),
        dataset_id=str(data["datasetId"]),
        target_profile=dict(data.get("targetProfile", {})),
        evidence_graph_version=data.get("evidenceGraphVersion"),
    )


def task_from_dict(data: Mapping[str, Any]) -> EvaluationTask:
    return EvaluationTask(
        id=str(data["id"]),
        requirement=str(data["requirement"]),
        base_sha=str(data["baseSha"]),
        required_rules=tuple_of_strings(data["requiredRules"]),
        critical_rules=tuple_of_strings(data.get("criticalRules", [])),
        allowed_paths=tuple_of_strings(data.get("allowedPaths", [])),
        forbidden_paths=tuple_of_strings(data.get("forbiddenPaths", [])),
        metadata=dict(data.get("metadata", {})),
    )


def dataset_from_dict(data: Mapping[str, Any]) -> EvaluationDataset:
    return EvaluationDataset(
        id=str(data["id"]),
        version=str(data["version"]),
        development_tasks=tuple(
            task_from_dict(task) for task in data["developmentTasks"]
        ),
        validation_tasks=tuple(
            task_from_dict(task) for task in data["validationTasks"]
        ),
    )


def load_candidate(candidate_path: Path, skill_path: Path) -> SkillCandidate:
    content = skill_path.read_text(encoding="utf-8")
    return candidate_from_dict(load_json(candidate_path), content=content)


def load_dataset(dataset_path: Path) -> EvaluationDataset:
    return dataset_from_dict(load_json(dataset_path))

