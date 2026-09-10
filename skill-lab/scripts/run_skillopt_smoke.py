from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

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
from skill_lab.optimizers import SkillOptConfig, SkillOptOptimizer


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run one real Microsoft SkillOpt proposal through Bailian"
    )
    parser.add_argument("--state-dir", type=Path, required=True)
    args = parser.parse_args()

    skill_content = "# API implementation skill\n\n- Only change files in the allowed scope.\n"
    skill = SkillVersion(
        skill_id="skillopt-smoke",
        version="0.1.0",
        content=skill_content,
        checksum=content_hash(skill_content),
        parent_version=None,
        created_at=utc_now(),
    )
    task = EvaluationTask(
        id="stable-health-list",
        requirement="Return health checks in stable name order and use structured errors.",
        base_sha="smoke-base",
        required_rules=("stable ordering", "structured errors"),
        critical_rules=("stable ordering",),
        allowed_paths=("src/health",),
    )
    result = ExecutionResult(
        run_id="skillopt-smoke-run",
        task_id=task.id,
        skill_version=skill.version,
        checks=(
            CheckResult(
                name="hidden-stable-order",
                passed=False,
                critical=True,
                details="response order changes between runs",
            ),
            CheckResult(
                name="hidden-error-shape",
                passed=False,
                critical=False,
                details="error payload is plain text",
            ),
        ),
        changed_files=("src/health/list.ts",),
        diff="Health checks are returned from map iteration without sorting; errors use strings.",
        commands=("npm test",),
        violations=(),
        trace={"missing_rules": ["stable ordering", "structured errors"]},
        duration_ms=500,
    )
    assessment = SemanticAssessment(
        task_id=task.id,
        score=30.0,
        reasons=(
            "The implementation is nondeterministic and does not define a stable error contract.",
        ),
        evidence_refs=(
            "task:stable-health-list:check:hidden-stable-order",
            "task:stable-health-list:check:hidden-error-shape",
        ),
    )
    scorecard = ScoreCard(
        total=30.0,
        correctness=20.0,
        safety_scope=100.0,
        semantic_quality=30.0,
        stability_efficiency=70.0,
        hard_failures=("hidden-stable-order",),
        violations=(),
    )

    args.state_dir.mkdir(parents=True, exist_ok=True)
    optimizer = SkillOptOptimizer(
        SkillOptConfig.from_env(),
        work_root=args.state_dir,
    )
    patch = optimizer.propose_patch(
        skill,
        (task,),
        (result,),
        (assessment,),
        scorecard,
        set(),
    )
    if patch is None:
        raise SystemExit("SkillOpt returned no patch for the failed smoke trajectory")
    print(
        json.dumps(
            {
                "additions": list(patch.additions),
                "reasons": list(patch.reasons),
                "evidenceRefs": list(patch.evidence_refs),
                "signature": patch.signature,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
