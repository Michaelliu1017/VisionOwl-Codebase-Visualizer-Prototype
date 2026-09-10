from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from skill_lab.models import SkillVersion, content_hash, utc_now
from skill_lab.registry import FileSkillRegistry


class RegistryTests(unittest.TestCase):
    def test_saves_active_version_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            registry = FileSkillRegistry(Path(directory))
            content = "# Skill\n"
            version = SkillVersion(
                skill_id="demo-skill",
                version="1.0.0",
                content=content,
                checksum=content_hash(content),
                parent_version=None,
                created_at=utc_now(),
            )
            registry.save_version(version, active=True)
            manifest = registry.load_manifest("demo-skill")
            self.assertIsNotNone(manifest)
            self.assertEqual(manifest["activeVersion"], "1.0.0")


if __name__ == "__main__":
    unittest.main()

