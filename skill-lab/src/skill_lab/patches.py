from __future__ import annotations

from .models import SkillPatch, SkillVersion, content_hash, utc_now


class PatchValidationError(ValueError):
    pass


class PatchValidator:
    def __init__(self, *, max_changes: int = 3, max_rule_length: int = 240) -> None:
        self.max_changes = max_changes
        self.max_rule_length = max_rule_length

    def validate(self, skill: SkillVersion, patch: SkillPatch) -> None:
        if not patch.additions:
            raise PatchValidationError("patch must contain at least one addition")
        if len(patch.additions) > self.max_changes:
            raise PatchValidationError("patch exceeds the configured change limit")
        if len(patch.reasons) != len(patch.additions):
            raise PatchValidationError("every addition needs a reason")
        if len(patch.evidence_refs) != len(patch.additions):
            raise PatchValidationError("every addition needs an evidence reference")
        normalized = [rule.strip().casefold() for rule in patch.additions]
        if len(set(normalized)) != len(normalized):
            raise PatchValidationError("patch contains duplicate additions")
        for rule in patch.additions:
            if not rule.strip():
                raise PatchValidationError("patch additions cannot be empty")
            if len(rule) > self.max_rule_length:
                raise PatchValidationError("patch addition is too long")
            if rule.casefold() in skill.content.casefold():
                raise PatchValidationError("patch repeats an existing rule")


def apply_patch(
    skill: SkillVersion,
    patch: SkillPatch,
    *,
    version: str,
    experiment_id: str,
) -> SkillVersion:
    section = "\n\n## 自动补充的工程规则\n"
    additions = "".join(f"\n- {rule}" for rule in patch.additions)
    content = skill.content.rstrip() + section + additions + "\n"
    return SkillVersion(
        skill_id=skill.skill_id,
        version=version,
        content=content,
        checksum=content_hash(content),
        parent_version=skill.version,
        created_at=utc_now(),
        source_experiment_id=experiment_id,
    )

