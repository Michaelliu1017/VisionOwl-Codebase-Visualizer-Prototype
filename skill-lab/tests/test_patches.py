from __future__ import annotations

import unittest

from skill_lab.models import SkillPatch, SkillVersion, content_hash, utc_now
from skill_lab.patches import PatchValidationError, PatchValidator, apply_patch


class PatchTests(unittest.TestCase):
    def setUp(self) -> None:
        content = "# Skill\n\n完成任务。\n"
        self.skill = SkillVersion(
            skill_id="demo",
            version="0.1.0",
            content=content,
            checksum=content_hash(content),
            parent_version=None,
            created_at=utc_now(),
        )

    def test_validates_and_applies_bounded_patch(self) -> None:
        patch = SkillPatch(
            additions=("执行完整测试",),
            reasons=("缺少验证步骤",),
            evidence_refs=("task:demo:test-failed",),
        )
        PatchValidator(max_changes=3).validate(self.skill, patch)
        updated = apply_patch(
            self.skill,
            patch,
            version="0.1.0-opt.1",
            experiment_id="experiment-1",
        )
        self.assertIn("执行完整测试", updated.content)
        self.assertEqual(updated.parent_version, self.skill.version)

    def test_rejects_too_many_changes(self) -> None:
        patch = SkillPatch(
            additions=("a", "b", "c", "d"),
            reasons=("a", "b", "c", "d"),
            evidence_refs=("a", "b", "c", "d"),
        )
        with self.assertRaises(PatchValidationError):
            PatchValidator(max_changes=3).validate(self.skill, patch)


if __name__ == "__main__":
    unittest.main()

