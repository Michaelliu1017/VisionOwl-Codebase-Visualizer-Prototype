from __future__ import annotations

import uuid
from typing import List, Optional, Sequence, Set

from .models import (
    CheckResult,
    EvaluationTask,
    ExecutionResult,
    ScoreCard,
    SemanticAssessment,
    SkillPatch,
    SkillVersion,
)


class FakeRunner:
    """Deterministically simulates Agent behavior from explicit skill rules."""

    def execute(self, skill: SkillVersion, task: EvaluationTask) -> ExecutionResult:
        normalized_skill = skill.content.casefold()
        missing_rules: List[str] = []
        checks: List[CheckResult] = []

        for rule in task.required_rules:
            passed = rule.casefold() in normalized_skill
            if not passed:
                missing_rules.append(rule)
            checks.append(
                CheckResult(
                    name=f"required-rule:{rule}",
                    passed=passed,
                    critical=not task.critical_rules or rule in task.critical_rules,
                    details="rule present in skill" if passed else "rule missing from skill",
                )
            )

        changed_file = (
            task.allowed_paths[0]
            if task.allowed_paths
            else f"modules/{task.id}/src/index.py"
        )
        return ExecutionResult(
            run_id=str(uuid.uuid4()),
            task_id=task.id,
            skill_version=skill.version,
            checks=tuple(checks),
            changed_files=(changed_file,),
            diff=f"simulated diff for {task.id} with {skill.version}",
            commands=("run repository tests",),
            violations=(),
            trace={
                "missing_rules": missing_rules,
                "required_rules": list(task.required_rules),
            },
            duration_ms=10,
            efficiency_score=100.0,
            provider="fake-runner",
        )


class FakeJudge:
    """Provides deterministic, evidence-bearing semantic feedback."""

    def evaluate(
        self,
        skill: SkillVersion,
        task: EvaluationTask,
        result: ExecutionResult,
    ) -> SemanticAssessment:
        del skill
        total = len(result.checks)
        passed = sum(1 for check in result.checks if check.passed)
        score = (passed / total) * 100.0 if total else 0.0
        failed = [check for check in result.checks if not check.passed]
        reasons = tuple(
            f"Skill 未约束：{check.name.removeprefix('required-rule:')}"
            if hasattr(str, "removeprefix")
            else f"Skill 未约束：{check.name.replace('required-rule:', '', 1)}"
            for check in failed
        )
        evidence_refs = tuple(
            f"task:{task.id}:check:{check.name}" for check in failed
        )
        if not reasons:
            reasons = ("所有任务规则均有明确指导",)
            evidence_refs = (f"task:{task.id}:all-checks-passed",)
        return SemanticAssessment(
            task_id=task.id,
            score=round(score, 2),
            reasons=reasons,
            evidence_refs=evidence_refs,
        )


class FakeOptimizer:
    """Adds missing rules in bounded patches to exercise the control loop."""

    def __init__(self, *, max_changes: int = 3) -> None:
        self.max_changes = max_changes

    def propose_patch(
        self,
        skill: SkillVersion,
        tasks: Sequence[EvaluationTask],
        results: Sequence[ExecutionResult],
        assessments: Sequence[SemanticAssessment],
        scorecard: ScoreCard,
        rejected_signatures: Set[str],
    ) -> Optional[SkillPatch]:
        del tasks, assessments, scorecard
        missing: List[str] = []
        evidence: List[str] = []
        for result in results:
            for rule in result.trace.get("missing_rules", []):
                if rule in missing or rule.casefold() in skill.content.casefold():
                    continue
                missing.append(rule)
                evidence.append(f"task:{result.task_id}:missing-rule:{rule}")

        if not missing:
            return None

        additions = tuple(missing[: self.max_changes])
        patch = SkillPatch(
            additions=additions,
            reasons=tuple(f"补充失败任务缺少的约束：{rule}" for rule in additions),
            evidence_refs=tuple(evidence[: len(additions)]),
        )
        if patch.signature in rejected_signatures:
            return None
        return patch
