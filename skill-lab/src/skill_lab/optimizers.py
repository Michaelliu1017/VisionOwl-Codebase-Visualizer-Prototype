from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Protocol, Sequence, Set, Tuple

from .models import (
    EvaluationTask,
    ExecutionResult,
    ScoreCard,
    SemanticAssessment,
    SkillPatch,
    SkillVersion,
)


class OptimizerConfigurationError(ValueError):
    pass


class OptimizerDependencyError(RuntimeError):
    pass


class OptimizerProviderError(RuntimeError):
    pass


@dataclass(frozen=True)
class SkillOptConfig:
    api_key: str
    base_url: str
    model: str = "qwen-plus"
    max_changes: int = 3
    minibatch_size: int = 8
    workers: int = 1
    timeout_seconds: float = 180.0
    max_tokens: int = 8_000
    temperature: float = 0.1
    semantic_pass_score: float = 80.0
    failure_only: bool = True
    max_skill_chars: int = 24_000
    max_diff_chars: int = 32_000
    max_rule_chars: int = 220

    def __post_init__(self) -> None:
        if not self.api_key.strip():
            raise OptimizerConfigurationError(
                "Bailian optimizer API key is required; set "
                "BAILIAN_OPTIMIZER_API_KEY, BAILIAN_API_KEY or DASHSCOPE_API_KEY"
            )
        if not self.base_url.strip():
            raise OptimizerConfigurationError(
                "Bailian optimizer base URL is required; set "
                "BAILIAN_OPTIMIZER_BASE_URL or BAILIAN_BASE_URL"
            )
        if not self.model.strip():
            raise OptimizerConfigurationError("optimizer model cannot be empty")
        if not 1 <= self.max_changes <= 3:
            raise OptimizerConfigurationError(
                "optimizer max changes must be between 1 and 3"
            )
        if self.minibatch_size < 1 or self.workers < 1:
            raise OptimizerConfigurationError(
                "optimizer minibatch size and workers must be positive"
            )
        if self.timeout_seconds <= 0 or self.max_tokens < 1:
            raise OptimizerConfigurationError(
                "optimizer timeout and token limit must be positive"
            )
        if not 0.0 <= self.temperature <= 2.0:
            raise OptimizerConfigurationError(
                "optimizer temperature must be between 0 and 2"
            )
        if not 0.0 <= self.semantic_pass_score <= 100.0:
            raise OptimizerConfigurationError(
                "optimizer semantic pass score must be between 0 and 100"
            )
        if min(
            self.max_skill_chars,
            self.max_diff_chars,
            self.max_rule_chars,
        ) < 1:
            raise OptimizerConfigurationError(
                "optimizer input and rule limits must be positive"
            )

    @classmethod
    def from_env(
        cls,
        environ: Optional[Mapping[str, str]] = None,
    ) -> "SkillOptConfig":
        values = environ if environ is not None else os.environ
        return cls(
            api_key=(
                values.get("BAILIAN_OPTIMIZER_API_KEY")
                or values.get("BAILIAN_API_KEY")
                or values.get("DASHSCOPE_API_KEY")
                or ""
            ),
            base_url=(
                values.get("BAILIAN_OPTIMIZER_BASE_URL")
                or values.get("BAILIAN_BASE_URL")
                or ""
            ),
            model=values.get("BAILIAN_OPTIMIZER_MODEL", "qwen-plus"),
            max_changes=_int_env(values, "SKILLOPT_MAX_CHANGES", 3),
            minibatch_size=_int_env(values, "SKILLOPT_MINIBATCH_SIZE", 8),
            workers=_int_env(values, "SKILLOPT_WORKERS", 1),
            timeout_seconds=_float_env(
                values, "BAILIAN_OPTIMIZER_TIMEOUT_SECONDS", 180.0
            ),
            max_tokens=_int_env(values, "BAILIAN_OPTIMIZER_MAX_TOKENS", 8_000),
            temperature=_float_env(
                values, "BAILIAN_OPTIMIZER_TEMPERATURE", 0.1
            ),
            semantic_pass_score=_float_env(
                values, "SKILLOPT_SEMANTIC_PASS_SCORE", 80.0
            ),
            failure_only=_bool_env(values, "SKILLOPT_FAILURE_ONLY", True),
            max_skill_chars=_int_env(
                values, "SKILLOPT_MAX_SKILL_CHARS", 24_000
            ),
            max_diff_chars=_int_env(
                values, "SKILLOPT_MAX_DIFF_CHARS", 32_000
            ),
            max_rule_chars=_int_env(
                values, "SKILLOPT_MAX_RULE_CHARS", 220
            ),
        )


class SkillOptProposalEngine(Protocol):
    def propose(
        self,
        *,
        skill_content: str,
        rollouts: Sequence[Mapping[str, Any]],
        prediction_dir: Path,
        patches_dir: Path,
        rejected_context: str,
    ) -> Mapping[str, Any]:
        ...


_SKILLOPT_LOCK = threading.Lock()


class MicrosoftSkillOptEngine:
    """Runs SkillOpt Reflect, Aggregate and Select against Bailian."""

    def __init__(self, config: SkillOptConfig) -> None:
        self.config = config
        try:
            from skillopt.gradient import merge_patches, run_minibatch_reflect
            from skillopt.model import configure_openai_compatible
            from skillopt.model.backend_config import set_optimizer_backend
            from skillopt.optimizer import rank_and_select
        except ImportError as error:
            raise OptimizerDependencyError(
                "Microsoft SkillOpt is unavailable; install the evaluation extra "
                "with Python 3.10+: python -m pip install -e '.[evaluation]'"
            ) from error

        self._configure = configure_openai_compatible
        self._set_backend = set_optimizer_backend
        self._reflect = run_minibatch_reflect
        self._merge = merge_patches
        self._select = rank_and_select

    def propose(
        self,
        *,
        skill_content: str,
        rollouts: Sequence[Mapping[str, Any]],
        prediction_dir: Path,
        patches_dir: Path,
        rejected_context: str,
    ) -> Mapping[str, Any]:
        with _SKILLOPT_LOCK:
            self._set_backend("openai_compatible")
            self._configure(
                optimizer_base_url=self.config.base_url,
                optimizer_api_key=self.config.api_key,
                optimizer_model=self.config.model,
                temperature=self.config.temperature,
                timeout_seconds=self.config.timeout_seconds,
                max_tokens=self.config.max_tokens,
            )
            raw = self._reflect(
                list(rollouts),
                skill_content,
                str(prediction_dir),
                str(patches_dir),
                workers=self.config.workers,
                failure_only=self.config.failure_only,
                minibatch_size=self.config.minibatch_size,
                edit_budget=self.config.max_changes,
                random_seed=17,
                error_system=_ERROR_ANALYST_PROMPT,
                success_system=_SUCCESS_ANALYST_PROMPT,
                step_buffer_context=rejected_context,
                update_mode="patch",
                skill_aware_reflection=False,
            )

            if not raw:
                if any(float(item.get("hard", 0.0)) < 1.0 for item in rollouts):
                    raise OptimizerProviderError(
                        "SkillOpt/Bailian returned no reflection result for failed trajectories"
                    )
                return {}

            failure, success = _normalise_raw_patches(raw)
            if not failure and not success:
                return {}
            merged = self._merge(
                skill_content,
                failure,
                success,
                batch_size=max(2, self.config.minibatch_size),
                verbose=False,
                workers=self.config.workers,
                update_mode="patch",
            )
            selected = self._select(
                skill_content,
                merged,
                max_edits=self.config.max_changes,
                update_mode="patch",
            )
            return selected if isinstance(selected, Mapping) else {}


class SkillOptOptimizer:
    """Adapts Microsoft SkillOpt proposals to VisionOwl's bounded patch gate."""

    def __init__(
        self,
        config: SkillOptConfig,
        *,
        work_root: Optional[Path] = None,
        engine: Optional[SkillOptProposalEngine] = None,
    ) -> None:
        self.config = config
        self.work_root = work_root.resolve() if work_root else None
        if self.work_root:
            self.work_root.mkdir(parents=True, exist_ok=True)
        self.engine = engine or MicrosoftSkillOptEngine(config)
        self._patch_history: Dict[str, SkillPatch] = {}

    def propose_patch(
        self,
        skill: SkillVersion,
        tasks: Sequence[EvaluationTask],
        results: Sequence[ExecutionResult],
        assessments: Sequence[SemanticAssessment],
        scorecard: ScoreCard,
        rejected_signatures: Set[str],
    ) -> Optional[SkillPatch]:
        if not tasks or len(tasks) != len(results):
            raise OptimizerProviderError(
                "optimizer tasks and execution results must be non-empty and aligned"
            )
        if len(assessments) != len(results):
            raise OptimizerProviderError(
                "optimizer semantic assessments and execution results must be aligned"
            )
        if _is_fully_successful(results, assessments, scorecard):
            return None

        if self.work_root:
            run_root = self.work_root / _safe_run_name(skill)
            run_root.mkdir(parents=True, exist_ok=False)
            return self._propose_in(
                run_root,
                skill,
                tasks,
                results,
                assessments,
                rejected_signatures,
            )

        with tempfile.TemporaryDirectory(prefix="visionowl-skillopt-") as directory:
            return self._propose_in(
                Path(directory),
                skill,
                tasks,
                results,
                assessments,
                rejected_signatures,
            )

    def _propose_in(
        self,
        run_root: Path,
        skill: SkillVersion,
        tasks: Sequence[EvaluationTask],
        results: Sequence[ExecutionResult],
        assessments: Sequence[SemanticAssessment],
        rejected_signatures: Set[str],
    ) -> Optional[SkillPatch]:
        prediction_dir = run_root / "predictions"
        patches_dir = run_root / "patches"
        prediction_dir.mkdir(parents=True, exist_ok=True)
        patches_dir.mkdir(parents=True, exist_ok=True)
        rollouts = self._build_rollouts(
            skill,
            tasks,
            results,
            assessments,
            prediction_dir,
        )
        rejected_context = self._rejected_context(rejected_signatures)
        proposal = self.engine.propose(
            skill_content=_bounded(_redact(skill.content), self.config.max_skill_chars),
            rollouts=rollouts,
            prediction_dir=prediction_dir,
            patches_dir=patches_dir,
            rejected_context=rejected_context,
        )
        _write_json(run_root / "skillopt-proposal.json", proposal)
        patch = self._to_patch(proposal, assessments, results)
        if patch is None:
            return None
        self._patch_history[patch.signature] = patch
        if patch.signature in rejected_signatures:
            return None
        return patch

    def _build_rollouts(
        self,
        skill: SkillVersion,
        tasks: Sequence[EvaluationTask],
        results: Sequence[ExecutionResult],
        assessments: Sequence[SemanticAssessment],
        prediction_dir: Path,
    ) -> List[Mapping[str, Any]]:
        rollouts: List[Mapping[str, Any]] = []
        for task, result, assessment in zip(tasks, results, assessments):
            rollout_id = _safe_task_id(task.id)
            failed_checks = [check for check in result.checks if not check.passed]
            hard = float(
                not result.violations
                and not any(check.critical for check in failed_checks)
                and assessment.score >= self.config.semantic_pass_score
            )
            failure_parts = [check.name for check in failed_checks]
            failure_parts.extend(result.violations)
            failure_parts.extend(assessment.reasons)
            verification = {
                "taskId": task.id,
                "checks": [
                    {
                        "name": check.name,
                        "passed": check.passed,
                        "critical": check.critical,
                        "details": _bounded(_redact(check.details), 1_500),
                    }
                    for check in result.checks
                ],
                "violations": [
                    _bounded(_redact(item), 1_500) for item in result.violations
                ],
                "semanticScore": assessment.score,
                "semanticReasons": [
                    _bounded(_redact(item), 2_000) for item in assessment.reasons
                ],
                "evidenceRefs": list(assessment.evidence_refs[:32]),
            }
            conversation = [
                {
                    "role": "user",
                    "content": _bounded(_redact(task.requirement), 8_000),
                },
                {
                    "role": "assistant",
                    "content": _bounded(
                        _redact(
                            "Changed files: "
                            + json.dumps(list(result.changed_files), ensure_ascii=False)
                            + "\n\nDiff:\n"
                            + result.diff
                        ),
                        self.config.max_diff_chars,
                    ),
                },
                {
                    "role": "system",
                    "content": json.dumps(
                        verification,
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                },
            ]
            task_dir = prediction_dir / rollout_id
            task_dir.mkdir(parents=True, exist_ok=True)
            _write_json(task_dir / "conversation.json", conversation)
            rollouts.append(
                {
                    "id": rollout_id,
                    "hard": hard,
                    "soft": max(0.0, min(1.0, assessment.score / 100.0)),
                    "n_turns": len(result.commands),
                    "fail_reason": _bounded(
                        "; ".join(item for item in failure_parts if item), 4_000
                    ),
                    "task_description": _bounded(
                        _redact(task.requirement), 8_000
                    ),
                    "task_type": str(task.metadata.get("taskType", "code-change")),
                    "reference_text": json.dumps(
                        {
                            "requiredRules": list(task.required_rules),
                            "criticalRules": list(task.critical_rules),
                            "allowedPaths": list(task.allowed_paths),
                            "forbiddenPaths": list(task.forbidden_paths),
                            "evidenceRefs": list(assessment.evidence_refs[:32]),
                        },
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                }
            )
        return rollouts

    def _to_patch(
        self,
        proposal: Mapping[str, Any],
        assessments: Sequence[SemanticAssessment],
        results: Sequence[ExecutionResult],
    ) -> Optional[SkillPatch]:
        raw_edits = proposal.get("edits", [])
        if not isinstance(raw_edits, list):
            raise OptimizerProviderError("SkillOpt proposal edits must be an array")
        additions: List[str] = []
        for item in raw_edits:
            if not isinstance(item, Mapping) or item.get("op") != "append":
                continue
            content = _normalise_rule(str(item.get("content", "")))
            if not content or len(content) > self.config.max_rule_chars:
                continue
            if content.casefold() in {value.casefold() for value in additions}:
                continue
            additions.append(content)
            if len(additions) >= self.config.max_changes:
                break
        if not additions:
            return None

        reasoning = _bounded(
            _redact(str(proposal.get("reasoning") or "SkillOpt failure reflection")),
            2_000,
        )
        evidence = [
            ref
            for assessment in assessments
            for ref in assessment.evidence_refs
        ]
        if not evidence:
            evidence = [
                f"task:{result.task_id}:run:{result.run_id}" for result in results
            ]
        refs = tuple(evidence[index % len(evidence)] for index in range(len(additions)))
        return SkillPatch(
            additions=tuple(additions),
            reasons=tuple(reasoning for _ in additions),
            evidence_refs=refs,
        )

    def _rejected_context(self, rejected_signatures: Set[str]) -> str:
        items = []
        for signature in sorted(rejected_signatures):
            patch = self._patch_history.get(signature)
            if patch is None:
                items.append(f"- rejected signature: {signature}")
                continue
            items.append(
                f"- rejected signature {signature}: "
                + " | ".join(patch.additions)
            )
        if not items:
            return ""
        return (
            "These edits were rejected by the held-out validation gate. "
            "Do not repeat them verbatim:\n" + "\n".join(items)
        )


_ERROR_ANALYST_PROMPT = """You optimize an Agent skill from failed coding trajectories.
Find recurring, evidence-backed failures and propose at most the requested number of changes.
Every change MUST be one concise, general, actionable rule no longer than 220 characters.
Only append new rules. Never replace or delete existing text. Do not copy secrets, absolute paths,
task-specific identifiers, expected answers, hidden-test details, or repository-specific constants.
Do not repeat guidance already present in the skill or rejected by the validation gate.

Return only valid JSON:
{
  "batch_size": 1,
  "failure_summary": [{"failure_type": "type", "count": 1, "description": "reason"}],
  "patch": {
    "reasoning": "evidence-backed explanation",
    "edits": [{"op": "append", "content": "one actionable rule"}]
  }
}
Return an empty edits array when no justified change exists.
"""


_SUCCESS_ANALYST_PROMPT = """You preserve reusable behavior from successful coding trajectories.
Propose only missing, general safeguards that help retain demonstrated success. Every change MUST
be one concise actionable rule no longer than 220 characters and MUST use op=append. Never include
secrets, absolute paths, task-specific identifiers, expected answers, or repository constants.

Return only valid JSON with a patch.edits array. Return an empty array when no change is needed.
"""


def _normalise_raw_patches(
    raw_patches: Sequence[Optional[Mapping[str, Any]]],
) -> Tuple[List[Mapping[str, Any]], List[Mapping[str, Any]]]:
    failure: List[Mapping[str, Any]] = []
    success: List[Mapping[str, Any]] = []
    for item in raw_patches:
        if not isinstance(item, Mapping):
            continue
        inner = item.get("patch", item)
        if not isinstance(inner, Mapping):
            continue
        edits = inner.get("edits", [])
        if not isinstance(edits, list) or not edits:
            continue
        normalised = dict(inner)
        normalised["edits"] = [
            dict(edit) for edit in edits if isinstance(edit, Mapping)
        ]
        if not normalised["edits"]:
            continue
        target = success if item.get("source_type") == "success" else failure
        target.append(normalised)
    return failure, success


def _is_fully_successful(
    results: Sequence[ExecutionResult],
    assessments: Sequence[SemanticAssessment],
    scorecard: ScoreCard,
) -> bool:
    return (
        scorecard.total >= 99.999
        and all(not result.violations for result in results)
        and all(
            check.passed
            for result in results
            for check in result.checks
            if check.critical
        )
        and all(assessment.score >= 99.999 for assessment in assessments)
    )


def _normalise_rule(value: str) -> str:
    value = re.sub(r"^\s*[-*]\s+", "", value.strip())
    return re.sub(r"\s+", " ", value).strip()


def _safe_task_id(value: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-.") or "task"
    suffix = hashlib.sha256(value.encode("utf-8")).hexdigest()[:8]
    return f"{stem[:64]}-{suffix}"


def _safe_run_name(skill: SkillVersion) -> str:
    stem = re.sub(
        r"[^A-Za-z0-9_.-]+",
        "-",
        f"{skill.skill_id}-{skill.version}",
    ).strip("-.")
    return f"{stem[:80]}-{uuid.uuid4().hex[:8]}"


def _write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def _bounded(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return f"{value[:limit]}\n...[truncated {len(value) - limit} characters]"


_SECRET_PATTERNS = (
    re.compile(r"(?i)(authorization\s*:\s*bearer\s+)[^\s\"']+"),
    re.compile(r"(?i)((?:api[_-]?key|token|secret)\s*[=:]\s*)[^\s\"']+"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{8,}\b"),
)


def _redact(value: str) -> str:
    redacted = value.replace(str(Path.home()), "$HOME")
    for pattern in _SECRET_PATTERNS:
        if pattern.groups:
            redacted = pattern.sub(r"\1[REDACTED]", redacted)
        else:
            redacted = pattern.sub("[REDACTED]", redacted)
    return redacted


def _int_env(values: Mapping[str, str], name: str, default: int) -> int:
    raw = values.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as error:
        raise OptimizerConfigurationError(f"{name} must be an integer") from error


def _float_env(values: Mapping[str, str], name: str, default: float) -> float:
    raw = values.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError as error:
        raise OptimizerConfigurationError(f"{name} must be a number") from error


def _bool_env(values: Mapping[str, str], name: str, default: bool) -> bool:
    raw = values.get(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise OptimizerConfigurationError(f"{name} must be a boolean")
