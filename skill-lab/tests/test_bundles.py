from __future__ import annotations

import io
import json
import unittest
import zipfile

from skill_lab.bundles import BundleError, build_zip, load_skill_bundle, read_zip


class BundleTests(unittest.TestCase):
    def test_round_trips_a_skills_bundle(self) -> None:
        files = {
            "skills/review/SKILL.md": b"# Review\n",
            "evaluation/dataset.json": json.dumps(
                {
                    "usable": True,
                    "developmentTasks": [{}],
                    "validationTasks": [{}],
                }
            ).encode(),
        }
        manifest = json.dumps(
            {"schemaVersion": "1.0", "kind": "skills", "title": "Skills", "files": []}
        ).encode()

        bundle = load_skill_bundle(build_zip(files, manifest))

        self.assertEqual(bundle.skills(), (("skills/review/SKILL.md", "# Review\n"),))
        self.assertTrue(bundle.evaluation_dataset()["usable"])

    def test_rejects_zip_path_traversal(self) -> None:
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("../secret.txt", b"no")

        with self.assertRaisesRegex(BundleError, "unsafe archive path"):
            read_zip(output.getvalue())


if __name__ == "__main__":
    unittest.main()
