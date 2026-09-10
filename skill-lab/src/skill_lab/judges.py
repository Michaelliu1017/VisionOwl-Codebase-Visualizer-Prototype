from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Optional, Protocol, Tuple, Type

from .models import (
    EvaluationTask,
    ExecutionResult,
    SemanticAssessment,
    SkillVersion,
)


class JudgeConfigurationError(ValueError):
    pass


class JudgeDependencyError(RuntimeError):
    pass


class JudgeProviderError(RuntimeError):
    pass


@dataclass(frozen=True)
class BailianJudgeConfig:
    api_key: str
    base_url: str
    model: str = "qwen-plus"
    timeout_seconds: float = 120.0
    max_retries: int = 2
    threshold: float = 0.7
    max_skill_chars: int = 24_000
    max_diff_chars: int = 40_000

    def __post_init__(self) -> None:
        if not self.api_key.strip():
            raise JudgeConfigurationError(
                "Bailian API key is required; set BAILIAN_API_KEY or "
                "DASHSCOPE_API_KEY"
            )
        if not self.base_url.strip():
            raise JudgeConfigurationError(
                "Bailian OpenAI-compatible base URL is required; set "
                "BAILIAN_BASE_URL"
            )
        if not self.model.strip():
            raise JudgeConfigurationError("Bailian judge model cannot be empty")
        if self.timeout_seconds <= 0:
            raise JudgeConfigurationError("judge timeout must be positive")
        if self.max_retries < 0:
            raise JudgeConfigurationError("judge max retries cannot be negative")
        if not 0.0 <= self.threshold <= 1.0:
            raise JudgeConfigurationError("judge threshold must be between 0 and 1")
        if self.max_skill_chars < 1 or self.max_diff_chars < 1:
            raise JudgeConfigurationError("judge input limits must be positive")

    @classmethod
    def from_env(cls, environ: Optional[Mapping[str, str]] = None) -> "BailianJudgeConfig":
        values = environ if environ is not None else os.environ
        return cls(
            api_key=(
                values.get("BAILIAN_API_KEY")
                or values.get("DASHSCOPE_API_KEY")
                or ""
            ),
            base_url=values.get("BAILIAN_BASE_URL", ""),
            model=values.get("BAILIAN_JUDGE_MODEL", "qwen-plus"),
            timeout_seconds=_float_env(
                values, "BAILIAN_JUDGE_TIMEOUT_SECONDS", 120.0
            ),
            max_retries=_int_env(values, "BAILIAN_JUDGE_MAX_RETRIES", 2),
            threshold=_float_env(values, "BAILIAN_JUDGE_THRESHOLD", 0.7),
            max_skill_chars=_int_env(
                values, "BAILIAN_JUDGE_MAX_SKILL_CHARS", 24_000
            ),
            max_diff_chars=_int_env(
                values, "BAILIAN_JUDGE_MAX_DIFF_CHARS", 40_000
            ),
        )


@dataclass(frozen=True)
class JudgeCase:
    input_text: str
    actual_output: str
    expected_output: str


@dataclass(frozen=True)
class JudgeMetricResult:
    score: float
    reason: str


class JudgeMetricRunner(Protocol):
    def measure(self, case: JudgeCase) -> JudgeMetricResult:
        ...


class DeepEvalGEvalRunner:
    """Runs one consolidated G-Eval rubric against a Bailian-hosted model."""

    def __init__(self, config: BailianJudgeConfig) -> None:
        # Evaluation evidence can contain internal engineering context. Keep
        # DeepEval local and send model input only to the configured Bailian API.
        os.environ.setdefault("DEEPEVAL_TELEMETRY_OPT_OUT", "YES")
        try:
            from deepeval.metrics import GEval
            from deepeval.test_case import LLMTestCase, LLMTestCaseParams
        except ImportError as error:
            raise JudgeDependencyError(
                "DeepEval Judge dependencies are unavailable; install the "
                "evaluation extra with: python3 -m pip install -e '.[evaluation]'"
            ) from error

        self._test_case_type = LLMTestCase
        self._metric = GEval(
            name="Skill execution semantic quality",
            criteria=(
                "仅依据输入中的候选 Skill、开发需求、验收条件、代码 Diff、"
                "检查结果和违规记录评价本次执行。综合判断需求符合度、Skill "
                "指导有效性、实现质量和验证充分度。关键检查失败、越界修改或"
                "缺乏证据时必须扣分，不得假设输入中没有提供的事实。"
            ),
            evaluation_steps=[
                "对照开发需求、requiredRules 和 criticalRules，检查代码 Diff 与检查结果是否证明需求已实现。",
                "判断候选 Skill 是否给出明确、可执行的指导，并结合 missingRules 分析其缺陷。",
                "检查实现是否存在越界修改、关键检查失败、明显设计缺陷或缺乏必要验证。",
                "只依据输入中的证据给出整体分数和具体原因；不得推断未提供的源码或测试结果。",
            ],
            evaluation_params=[
                LLMTestCaseParams.INPUT,
                LLMTestCaseParams.ACTUAL_OUTPUT,
                LLMTestCaseParams.EXPECTED_OUTPUT,
            ],
            model=_build_bailian_deepeval_model(config),
            threshold=config.threshold,
            async_mode=False,
            verbose_mode=False,
        )

    def measure(self, case: JudgeCase) -> JudgeMetricResult:
        test_case = self._test_case_type(
            input=case.input_text,
            actual_output=case.actual_output,
            expected_output=case.expected_output,
        )
        try:
            # Only use DeepEval's public metric API. Private keyword arguments
            # changed between 4.x releases and previously broke production
            # while the semantic contract itself remained compatible.
            measured = self._metric.measure(test_case)
        except Exception as error:
            raise JudgeProviderError(
                f"DeepEval/Bailian judge call failed: {error}"
            ) from error

        score = measured if measured is not None else self._metric.score
        reason = str(self._metric.reason or "").strip()
        if score is None or not reason:
            raise JudgeProviderError(
                "DeepEval/Bailian judge returned an incomplete score or reason"
            )
        return JudgeMetricResult(score=float(score), reason=reason)


class DeepEvalJudge:
    """Builds bounded evidence and maps a DeepEval result to Skill Lab models."""

    def __init__(
        self,
        config: BailianJudgeConfig,
        *,
        metric_runner: Optional[JudgeMetricRunner] = None,
    ) -> None:
        self.config = config
        self.metric_runner = metric_runner or DeepEvalGEvalRunner(config)

    def evaluate(
        self,
        skill: SkillVersion,
        task: EvaluationTask,
        result: ExecutionResult,
    ) -> SemanticAssessment:
        case = self._build_case(skill, task, result)
        measured = self.metric_runner.measure(case)
        score = round(max(0.0, min(1.0, measured.score)) * 100.0, 2)
        return SemanticAssessment(
            task_id=task.id,
            score=score,
            reasons=(measured.reason,),
            evidence_refs=_evidence_refs(task, result),
        )

    def _build_case(
        self,
        skill: SkillVersion,
        task: EvaluationTask,
        result: ExecutionResult,
    ) -> JudgeCase:
        input_payload = {
            "taskId": task.id,
            "requirement": _redact(task.requirement),
            "candidateSkill": {
                "version": skill.version,
                "content": _bounded(
                    _redact(skill.content), self.config.max_skill_chars
                ),
            },
        }
        expected_payload = {
            "requiredRules": list(task.required_rules),
            "criticalRules": list(task.critical_rules),
            "allowedPaths": list(task.allowed_paths),
            "forbiddenPaths": list(task.forbidden_paths),
            "hardGatePolicy": (
                "关键检查失败或出现范围违规时，不得给出可发布结论"
            ),
        }
        actual_payload = {
            "runId": result.run_id,
            "provider": result.provider,
            "skillVersion": result.skill_version,
            "changedFiles": list(result.changed_files),
            "diff": _bounded(_redact(result.diff), self.config.max_diff_chars),
            "checks": [
                {
                    "name": check.name,
                    "passed": check.passed,
                    "critical": check.critical,
                    "details": _bounded(_redact(check.details), 2_000),
                }
                for check in result.checks
            ],
            "commands": [_bounded(_redact(item), 1_000) for item in result.commands],
            "violations": [_bounded(_redact(item), 2_000) for item in result.violations],
            "durationMs": result.duration_ms,
            "efficiencyScore": result.efficiency_score,
            "runnerSummary": {
                "returnCode": result.trace.get("qoder_returncode"),
                "timedOut": result.trace.get("qoder_timed_out"),
                "missingRules": result.trace.get("missing_rules", []),
            },
        }
        return JudgeCase(
            input_text=_json_text(input_payload),
            actual_output=_json_text(actual_payload),
            expected_output=_json_text(expected_payload),
        )


def _build_bailian_deepeval_model(config: BailianJudgeConfig) -> Any:
    try:
        from deepeval.models import DeepEvalBaseLLM
        from openai import OpenAI
    except ImportError as error:
        raise JudgeDependencyError(
            "DeepEval Judge dependencies are unavailable; install the "
            "evaluation extra with: python3 -m pip install -e '.[evaluation]'"
        ) from error

    class BailianDeepEvalModel(DeepEvalBaseLLM):
        def __init__(self) -> None:
            self._client = OpenAI(
                api_key=config.api_key,
                base_url=config.base_url.rstrip("/"),
                timeout=config.timeout_seconds,
                max_retries=config.max_retries,
            )

        def load_model(self) -> Any:
            return self._client

        def generate(self, prompt: str, schema: Optional[Type[Any]] = None) -> Any:
            try:
                response = self._client.chat.completions.create(
                    model=config.model,
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0,
                )
            except Exception as error:
                raise JudgeProviderError(f"Bailian request failed: {error}") from error
            content = response.choices[0].message.content
            if not isinstance(content, str) or not content.strip():
                raise JudgeProviderError("Bailian returned an empty judge response")
            if schema is None:
                return content
            return _schema_from_text(schema, content)

        async def a_generate(
            self, prompt: str, schema: Optional[Type[Any]] = None
        ) -> Any:
            return await asyncio.to_thread(self.generate, prompt, schema)

        def get_model_name(self) -> str:
            return f"bailian:{config.model}"

    return BailianDeepEvalModel()


def _schema_from_text(schema: Type[Any], text: str) -> Any:
    payload = _first_json_value(text)
    if hasattr(schema, "model_validate"):
        return schema.model_validate(payload)
    if hasattr(schema, "parse_obj"):
        return schema.parse_obj(payload)
    return schema(**payload)


def _first_json_value(text: str) -> Any:
    decoder = json.JSONDecoder()
    for index, character in enumerate(text):
        if character not in "[{":
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        return value
    raise JudgeProviderError("Bailian response does not contain valid JSON")


def _evidence_refs(
    task: EvaluationTask,
    result: ExecutionResult,
) -> Tuple[str, ...]:
    refs = [f"task:{task.id}:check:{check.name}" for check in result.checks]
    refs.extend(
        f"task:{task.id}:violation:{index + 1}"
        for index, _ in enumerate(result.violations)
    )
    refs.extend(f"task:{task.id}:file:{path}" for path in result.changed_files)
    if not refs:
        refs.append(f"task:{task.id}:run:{result.run_id}")
    return tuple(refs[:32])


def _json_text(value: Mapping[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)


def _bounded(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    omitted = len(value) - limit
    return f"{value[:limit]}\n...[truncated {omitted} characters]"


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
        raise JudgeConfigurationError(f"{name} must be an integer") from error


def _float_env(values: Mapping[str, str], name: str, default: float) -> float:
    raw = values.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError as error:
        raise JudgeConfigurationError(f"{name} must be a number") from error
