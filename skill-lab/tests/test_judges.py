from __future__ import annotations

import unittest
from pathlib import Path
from typing import Optional

from skill_lab.judges import (
    BailianJudgeConfig,
    DeepEvalGEvalRunner,
    DeepEvalJudge,
    JudgeConfigurationError,
    JudgeCase,
    JudgeMetricResult,
    _schema_from_text,
)
from skill_lab.models import (
    CheckResult,
    EvaluationTask,
    ExecutionResult,
    SkillVersion,
    content_hash,
    utc_now,
)


class StubMetricRunner:
    def __init__(self, score: float = 0.82, reason: str = "实现基本符合要求") -> None:
        self.result = JudgeMetricResult(score=score, reason=reason)
        self.case: Optional[JudgeCase] = None

    def measure(self, case: JudgeCase) -> JudgeMetricResult:
        self.case = case
        return self.result


class DeepEvalJudgeTests(unittest.TestCase):
    def test_metric_runner_uses_the_public_deepeval_measure_signature(self) -> None:
        class TestCase:
            def __init__(self, **values) -> None:
                self.values = values

        class PublicMetric:
            score = 0.91
            reason = "公开 API 调用成功"

            def measure(self, test_case):
                self.test_case = test_case
                return self.score

        runner = object.__new__(DeepEvalGEvalRunner)
        runner._test_case_type = TestCase
        runner._metric = PublicMetric()

        result = runner.measure(
            JudgeCase(
                input_text="requirement",
                actual_output="implementation",
                expected_output="acceptance",
            )
        )

        self.assertEqual(result.score, 0.91)
        self.assertEqual(result.reason, "公开 API 调用成功")
        self.assertEqual(runner._metric.test_case.values["input"], "requirement")

    def test_maps_metric_result_and_uses_bounded_redacted_evidence(self) -> None:
        metric = StubMetricRunner()
        judge = DeepEvalJudge(self._config(), metric_runner=metric)
        skill = self._skill()
        task = self._task()
        result = ExecutionResult(
            run_id="run-1",
            task_id=task.id,
            skill_version=skill.version,
            checks=(
                CheckResult(name="qoder-exit", passed=True),
                CheckResult(
                    name="hidden:error",
                    passed=False,
                    details="token=private-token-value",
                ),
            ),
            changed_files=("modules/demo/index.js",),
            diff=f"{Path.home()}/repo\nconst key = 'sk-secret123456';",
            commands=("node test.mjs",),
            violations=(),
            trace={"missing_rules": ["结构化错误"]},
            duration_ms=250,
        )

        assessment = judge.evaluate(skill, task, result)

        self.assertEqual(assessment.score, 82.0)
        self.assertEqual(assessment.reasons, ("实现基本符合要求",))
        self.assertIn("task:demo:check:hidden:error", assessment.evidence_refs)
        self.assertIsNotNone(metric.case)
        assert metric.case is not None
        self.assertIn("Candidate guidance", metric.case.input_text)
        self.assertIn("结构化错误", metric.case.expected_output)
        self.assertNotIn(str(Path.home()), metric.case.actual_output)
        self.assertNotIn("private-token-value", metric.case.actual_output)
        self.assertNotIn("sk-secret123456", metric.case.actual_output)
        self.assertIn("[REDACTED]", metric.case.actual_output)

    def test_loads_bailian_configuration_from_environment_mapping(self) -> None:
        config = BailianJudgeConfig.from_env(
            {
                "DASHSCOPE_API_KEY": "key-from-secret-store",
                "BAILIAN_BASE_URL": "https://example.test/compatible-mode/v1",
                "BAILIAN_JUDGE_MODEL": "qwen-plus",
                "BAILIAN_JUDGE_THRESHOLD": "0.75",
            }
        )

        self.assertEqual(config.api_key, "key-from-secret-store")
        self.assertEqual(config.model, "qwen-plus")
        self.assertEqual(config.threshold, 0.75)

    def test_rejects_missing_bailian_credentials(self) -> None:
        with self.assertRaises(JudgeConfigurationError):
            BailianJudgeConfig.from_env({})

    def test_parses_schema_from_json_surrounded_by_model_text(self) -> None:
        class ExampleSchema:
            @classmethod
            def model_validate(cls, payload):
                return payload

        parsed = _schema_from_text(
            ExampleSchema,
            'result follows\n```json\n{"score": 8, "reason": "ok"}\n```',
        )

        self.assertEqual(parsed, {"score": 8, "reason": "ok"})

    @staticmethod
    def _config() -> BailianJudgeConfig:
        return BailianJudgeConfig(
            api_key="test-key",
            base_url="https://example.test/compatible-mode/v1",
            max_skill_chars=5_000,
            max_diff_chars=5_000,
        )

    @staticmethod
    def _skill() -> SkillVersion:
        content = "# Skill\n\nCandidate guidance\n"
        return SkillVersion(
            skill_id="candidate",
            version="0.1.0",
            content=content,
            checksum=content_hash(content),
            parent_version=None,
            created_at=utc_now(),
        )

    @staticmethod
    def _task() -> EvaluationTask:
        return EvaluationTask(
            id="demo",
            requirement="实现演示模块",
            base_sha="abc123",
            required_rules=("结构化错误",),
            critical_rules=("结构化错误",),
            allowed_paths=("modules/demo",),
        )


if __name__ == "__main__":
    unittest.main()
