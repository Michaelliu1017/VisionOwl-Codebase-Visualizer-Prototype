from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

from skill_lab.models import (
    CheckResult,
    EvaluationTask,
    ExecutionResult,
    ScoreCard,
    SemanticAssessment,
    SkillVersion,
    content_hash,
    utc_now,
)
from skill_lab.optimizers import (
    OptimizerConfigurationError,
    OptimizerProviderError,
    SkillOptConfig,
    SkillOptOptimizer,
)


class StubSkillOptEngine:
    def __init__(
        self,
        proposal: Optional[Mapping[str, Any]] = None,
        error: Optional[Exception] = None,
    ) -> None:
        self.proposal = proposal or {}
        self.error = error
        self.calls = []

    def propose(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.proposal


class SkillOptOptimizerTests(unittest.TestCase):
    def test_maps_skillopt_append_edits_and_persists_redacted_trajectory(self) -> None:
        engine = StubSkillOptEngine(
            {
                "reasoning": "失败轨迹表明缺少稳定排序和结构化错误约束",
                "edits": [
                    {"op": "append", "content": "- 所有列表输出必须使用稳定排序。"},
                    {"op": "replace", "target": "old", "content": "ignored"},
                    {"op": "append", "content": "错误响应必须使用统一结构。"},
                ],
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            optimizer = SkillOptOptimizer(
                self._config(),
                work_root=Path(directory),
                engine=engine,
            )
            result = self._failed_result()
            patch = optimizer.propose_patch(
                self._skill(),
                (self._task(),),
                (result,),
                (self._assessment(),),
                self._scorecard(42.0),
                set(),
            )

            self.assertIsNotNone(patch)
            assert patch is not None
            self.assertEqual(
                patch.additions,
                ("所有列表输出必须使用稳定排序。", "错误响应必须使用统一结构。"),
            )
            self.assertEqual(len(patch.evidence_refs), 2)
            self.assertEqual(len(engine.calls), 1)
            rollout = engine.calls[0]["rollouts"][0]
            conversation_path = (
                engine.calls[0]["prediction_dir"]
                / str(rollout["id"])
                / "conversation.json"
            )
            conversation = conversation_path.read_text(encoding="utf-8")
            self.assertNotIn(str(Path.home()), conversation)
            self.assertNotIn("secret-value", conversation)
            self.assertIn("[REDACTED]", conversation)
            self.assertTrue(
                list(Path(directory).glob("*/skillopt-proposal.json"))
            )

    def test_does_not_repeat_a_patch_rejected_by_validation(self) -> None:
        engine = StubSkillOptEngine(
            {
                "reasoning": "missing rule",
                "edits": [{"op": "append", "content": "新增可验证规则。"}],
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            optimizer = SkillOptOptimizer(
                self._config(),
                work_root=Path(directory),
                engine=engine,
            )
            first = self._propose(optimizer, rejected=set())
            assert first is not None
            second = self._propose(optimizer, rejected={first.signature})

            self.assertIsNone(second)
            self.assertIn(
                first.signature,
                engine.calls[1]["rejected_context"],
            )

    def test_provider_failure_is_explicit_and_never_falls_back_to_fake(self) -> None:
        engine = StubSkillOptEngine(error=OptimizerProviderError("provider down"))
        optimizer = SkillOptOptimizer(self._config(), engine=engine)

        with self.assertRaisesRegex(OptimizerProviderError, "provider down"):
            self._propose(optimizer, rejected=set())

    def test_skips_optimizer_when_all_evidence_is_fully_successful(self) -> None:
        engine = StubSkillOptEngine(
            {"edits": [{"op": "append", "content": "should not run"}]}
        )
        optimizer = SkillOptOptimizer(self._config(), engine=engine)
        result = ExecutionResult(
            run_id="run-ok",
            task_id="task-1",
            skill_version="0.1.0",
            checks=(CheckResult(name="tests", passed=True, critical=True),),
            changed_files=("modules/demo/index.py",),
            diff="ok",
            commands=("pytest",),
            violations=(),
            trace={},
            duration_ms=10,
        )
        assessment = SemanticAssessment(
            task_id="task-1",
            score=100.0,
            reasons=("all good",),
            evidence_refs=("task:task-1:check:tests",),
        )

        patch = optimizer.propose_patch(
            self._skill(),
            (self._task(),),
            (result,),
            (assessment,),
            self._scorecard(100.0),
            set(),
        )

        self.assertIsNone(patch)
        self.assertFalse(engine.calls)

    def test_loads_bailian_optimizer_configuration(self) -> None:
        config = SkillOptConfig.from_env(
            {
                "DASHSCOPE_API_KEY": "test-key",
                "BAILIAN_BASE_URL": "https://example.test/compatible-mode/v1",
                "BAILIAN_OPTIMIZER_MODEL": "qwen-plus",
                "SKILLOPT_MAX_CHANGES": "2",
                "SKILLOPT_FAILURE_ONLY": "true",
            }
        )

        self.assertEqual(config.api_key, "test-key")
        self.assertEqual(config.max_changes, 2)
        self.assertTrue(config.failure_only)

    def test_rejects_more_than_three_optimizer_changes(self) -> None:
        with self.assertRaises(OptimizerConfigurationError):
            SkillOptConfig(
                api_key="test-key",
                base_url="https://example.test/v1",
                max_changes=4,
            )

    def _propose(self, optimizer: SkillOptOptimizer, *, rejected: set):
        return optimizer.propose_patch(
            self._skill(),
            (self._task(),),
            (self._failed_result(),),
            (self._assessment(),),
            self._scorecard(42.0),
            rejected,
        )

    @staticmethod
    def _config() -> SkillOptConfig:
        return SkillOptConfig(
            api_key="test-key",
            base_url="https://example.test/compatible-mode/v1",
        )

    @staticmethod
    def _skill() -> SkillVersion:
        content = "# Demo Skill\n\n仅修改需求范围内的代码。\n"
        return SkillVersion(
            skill_id="demo-skill",
            version="0.1.0",
            content=content,
            checksum=content_hash(content),
            parent_version=None,
            created_at=utc_now(),
        )

    @staticmethod
    def _task() -> EvaluationTask:
        return EvaluationTask(
            id="task-1",
            requirement="实现稳定列表接口",
            base_sha="abc123",
            required_rules=("稳定排序", "结构化错误"),
            critical_rules=("稳定排序",),
            allowed_paths=("modules/demo",),
        )

    @staticmethod
    def _failed_result() -> ExecutionResult:
        return ExecutionResult(
            run_id="run-failed",
            task_id="task-1",
            skill_version="0.1.0",
            checks=(
                CheckResult(
                    name="hidden-sort",
                    passed=False,
                    critical=True,
                    details="token=secret-value",
                ),
            ),
            changed_files=(f"{Path.home()}/repo/modules/demo/index.py",),
            diff="unstable output",
            commands=("pytest",),
            violations=(),
            trace={"missing_rules": ["稳定排序"]},
            duration_ms=50,
        )

    @staticmethod
    def _assessment() -> SemanticAssessment:
        return SemanticAssessment(
            task_id="task-1",
            score=35.0,
            reasons=("输出没有稳定排序",),
            evidence_refs=("task:task-1:check:hidden-sort",),
        )

    @staticmethod
    def _scorecard(total: float) -> ScoreCard:
        return ScoreCard(
            total=total,
            correctness=total,
            safety_scope=100.0,
            semantic_quality=total,
            stability_efficiency=100.0,
            hard_failures=() if total == 100.0 else ("hidden-sort",),
            violations=(),
        )


if __name__ == "__main__":
    unittest.main()
