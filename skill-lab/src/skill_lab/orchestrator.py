from __future__ import annotations

import re
import uuid
from pathlib import Path
from typing import List, Optional, Sequence, Set, Tuple

from .artifacts import LocalArtifactStore
from .evaluator import DeterministicEvaluator
from .events import FileOutbox
from .gates import QualityGate
from .models import (
    EvaluationBundle,
    EvaluationDataset,
    EvaluationTask,
    ExperimentReport,
    ExperimentStatus,
    GateDecision,
    RoundReport,
    SkillCandidate,
    SkillVersion,
    utc_now,
)
from .patches import PatchValidator, apply_patch
from .ports import Optimizer, Runner, SemanticJudge
from .registry import FileSkillRegistry
from .state_machine import ExperimentState


class ExperimentOrchestrator:
    def __init__(
        self,
        *,
        runner: Runner,
        judge: SemanticJudge,
        optimizer: Optimizer,
        evaluator: DeterministicEvaluator,
        patch_validator: PatchValidator,
        quality_gate: QualityGate,
        registry: FileSkillRegistry,
        artifact_store: LocalArtifactStore,
        outbox: FileOutbox,
        max_rounds: int = 5,
    ) -> None:
        if max_rounds < 1:
            raise ValueError("max rounds must be positive")
        self.runner = runner
        self.judge = judge
        self.optimizer = optimizer
        self.evaluator = evaluator
        self.patch_validator = patch_validator
        self.quality_gate = quality_gate
        self.registry = registry
        self.artifact_store = artifact_store
        self.outbox = outbox
        self.max_rounds = max_rounds

    def run(
        self,
        candidate: SkillCandidate,
        dataset: EvaluationDataset,
        *,
        experiment_id: Optional[str] = None,
    ) -> ExperimentReport:
        effective_experiment_id = experiment_id or str(uuid.uuid4())
        try:
            return self._run_impl(
                candidate,
                dataset,
                experiment_id=effective_experiment_id,
            )
        except Exception as error:
            self._record_failure(candidate, effective_experiment_id, error)
            raise

    def _run_impl(
        self,
        candidate: SkillCandidate,
        dataset: EvaluationDataset,
        *,
        experiment_id: str,
    ) -> ExperimentReport:
        if candidate.dataset_id != dataset.id:
            raise ValueError("candidate dataset id does not match the supplied dataset")

        started_at = utc_now()
        state = ExperimentState()
        baseline = SkillVersion.from_candidate(candidate)
        self.registry.save_version(baseline, active=False)

        state.transition(ExperimentStatus.BASELINE_RUNNING)
        self.outbox.publish(
            "skill.evaluation.started",
            project_id=candidate.project_id,
            skill_id=candidate.id,
            experiment_id=experiment_id,
            status=state.status.value,
        )
        baseline_development = self._evaluate(
            baseline,
            dataset.development_tasks,
        )
        baseline_validation = self._evaluate(
            baseline,
            dataset.validation_tasks,
        )

        state.transition(ExperimentStatus.OPTIMIZING)
        self.outbox.publish(
            "skill.optimization.started",
            project_id=candidate.project_id,
            skill_id=candidate.id,
            experiment_id=experiment_id,
            status=state.status.value,
            payload={"baselineScore": baseline_development.scorecard.total},
        )

        current_skill = baseline
        current_development = baseline_development
        rejected_signatures: Set[str] = set()
        rounds: List[RoundReport] = []
        accepted_version: Optional[SkillVersion] = None

        for round_number in range(1, self.max_rounds + 1):
            patch = self.optimizer.propose_patch(
                current_skill,
                dataset.development_tasks,
                current_development.execution_results,
                current_development.semantic_assessments,
                current_development.scorecard,
                rejected_signatures,
            )
            if patch is None:
                state.transition(ExperimentStatus.NO_IMPROVEMENT)
                break

            self.patch_validator.validate(current_skill, patch)
            proposed = apply_patch(
                current_skill,
                patch,
                version=f"{candidate.version}-opt.{round_number}",
                experiment_id=experiment_id,
            )
            proposed_development = self._evaluate(
                proposed,
                dataset.development_tasks,
            )

            if proposed_development.scorecard.total <= current_development.scorecard.total:
                rejected_signatures.add(patch.signature)
                round_report = RoundReport(
                    number=round_number,
                    candidate_version=proposed.version,
                    patch=patch,
                    development_score=proposed_development.scorecard,
                    validation_score=None,
                    decision=GateDecision.NO_IMPROVEMENT,
                    note="开发集分数没有提高，候选 Patch 被拒绝",
                )
                rounds.append(round_report)
                self._publish_round(candidate, experiment_id, round_report)
                continue

            state.transition(ExperimentStatus.VALIDATING)
            proposed_validation = self._evaluate(
                proposed,
                dataset.validation_tasks,
            )
            decision = self.quality_gate.decide(
                baseline_validation.scorecard,
                proposed_validation.scorecard,
            )
            note = (
                "候选版本通过独立验证集门禁"
                if decision == GateDecision.ACCEPTED
                else "候选版本尚未通过独立验证集门禁"
            )
            round_report = RoundReport(
                number=round_number,
                candidate_version=proposed.version,
                patch=patch,
                development_score=proposed_development.scorecard,
                validation_score=proposed_validation.scorecard,
                decision=decision,
                note=note,
            )
            rounds.append(round_report)
            self.registry.save_version(proposed, active=False)
            self._publish_round(candidate, experiment_id, round_report)

            if decision == GateDecision.ACCEPTED:
                accepted_version = proposed
                self.registry.save_version(proposed, active=True)
                state.transition(ExperimentStatus.COMPLETED)
                break

            current_skill = proposed
            current_development = proposed_development
            if round_number < self.max_rounds:
                state.transition(ExperimentStatus.OPTIMIZING)

        if state.status in {
            ExperimentStatus.OPTIMIZING,
            ExperimentStatus.VALIDATING,
        }:
            state.transition(ExperimentStatus.NO_IMPROVEMENT)

        report = ExperimentReport(
            experiment_id=experiment_id,
            candidate_id=candidate.id,
            status=state.status,
            baseline_version=baseline.version,
            accepted_version=accepted_version.version if accepted_version else None,
            baseline_development_score=baseline_development.scorecard,
            baseline_validation_score=baseline_validation.scorecard,
            rounds=tuple(rounds),
            started_at=started_at,
            finished_at=utc_now(),
        )
        artifact_refs = self._write_artifacts(
            report,
            accepted_version=accepted_version,
        )
        report = ExperimentReport(
            experiment_id=report.experiment_id,
            candidate_id=report.candidate_id,
            status=report.status,
            baseline_version=report.baseline_version,
            accepted_version=report.accepted_version,
            baseline_development_score=report.baseline_development_score,
            baseline_validation_score=report.baseline_validation_score,
            rounds=report.rounds,
            started_at=report.started_at,
            finished_at=report.finished_at,
            artifact_refs=artifact_refs,
        )
        self.registry.save_experiment(report)
        self._publish_final(candidate, report)
        return report

    def _record_failure(
        self,
        candidate: SkillCandidate,
        experiment_id: str,
        error: Exception,
    ) -> None:
        error_type = type(error).__name__
        message = _safe_failure_message(str(error))
        failure = {
            "schemaVersion": "skill-lab-failure.v1",
            "experimentId": experiment_id,
            "candidateId": candidate.id,
            "status": ExperimentStatus.FAILED.value,
            "errorType": error_type,
            "message": message,
            "failedAt": utc_now(),
        }
        try:
            failure_ref = self.artifact_store.write_json(
                experiment_id,
                "experiment-failure.json",
                failure,
            )
            self.outbox.publish(
                "skill.optimization.failed",
                project_id=candidate.project_id,
                skill_id=candidate.id,
                experiment_id=experiment_id,
                status=ExperimentStatus.FAILED.value,
                artifact_refs={"failure": failure_ref},
                payload={"errorType": error_type, "message": message},
            )
        except Exception:
            # Failure reporting must never hide the original execution error.
            return

    def _evaluate(
        self,
        skill: SkillVersion,
        tasks: Sequence[EvaluationTask],
    ) -> EvaluationBundle:
        execution_results = tuple(
            self.runner.execute(skill, task) for task in tasks
        )
        assessments = tuple(
            self.judge.evaluate(skill, task, result)
            for task, result in zip(tasks, execution_results)
        )
        scorecard = self.evaluator.score(execution_results, assessments)
        return EvaluationBundle(
            skill_version=skill.version,
            execution_results=execution_results,
            semantic_assessments=assessments,
            scorecard=scorecard,
        )

    def _write_artifacts(
        self,
        report: ExperimentReport,
        *,
        accepted_version: Optional[SkillVersion],
    ) -> dict:
        refs = {
            "report": self.artifact_store.write_json(
                report.experiment_id,
                "experiment-report.json",
                report,
            )
        }
        if accepted_version:
            refs["acceptedSkill"] = self.artifact_store.write_text(
                report.experiment_id,
                "accepted-skill.md",
                accepted_version.content,
            )
        return refs

    def _publish_round(
        self,
        candidate: SkillCandidate,
        experiment_id: str,
        report: RoundReport,
    ) -> None:
        self.outbox.publish(
            "skill.optimization.round.completed",
            project_id=candidate.project_id,
            skill_id=candidate.id,
            experiment_id=experiment_id,
            status=report.decision.value,
            payload={
                "round": report.number,
                "candidateVersion": report.candidate_version,
                "developmentScore": report.development_score.total,
                "validationScore": (
                    report.validation_score.total if report.validation_score else None
                ),
            },
        )

    def _publish_final(
        self,
        candidate: SkillCandidate,
        report: ExperimentReport,
    ) -> None:
        if report.status == ExperimentStatus.COMPLETED:
            event_type = "skill.optimization.completed"
        elif report.status == ExperimentStatus.NO_IMPROVEMENT:
            event_type = "skill.optimization.no_improvement"
        else:
            event_type = "skill.optimization.failed"
        self.outbox.publish(
            event_type,
            project_id=candidate.project_id,
            skill_id=candidate.id,
            experiment_id=report.experiment_id,
            status=report.status.value,
            artifact_refs=report.artifact_refs,
            payload={
                "baselineVersion": report.baseline_version,
                "acceptedVersion": report.accepted_version,
                "finalScore": report.final_score.total,
            },
        )


def _safe_failure_message(value: str) -> str:
    message = value.replace(str(Path.home()), "$HOME")
    message = re.sub(
        r"(?i)((?:api[_-]?key|token|secret)\s*[=:]\s*)[^\s\"']+",
        r"\1[REDACTED]",
        message,
    )
    message = re.sub(r"\bsk-[A-Za-z0-9_-]{8,}\b", "[REDACTED]", message)
    return message[:2_000]
