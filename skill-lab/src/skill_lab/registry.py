from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

from .models import ExperimentReport, SkillVersion
from .serialization import dumps, load_json, to_jsonable


_SAFE_ID = re.compile(r"^[A-Za-z0-9._-]+$")


def _safe_id(value: str) -> str:
    if not value or not _SAFE_ID.fullmatch(value):
        raise ValueError(f"unsafe registry identifier: {value!r}")
    return value


class FileSkillRegistry:
    """Development registry with atomic JSON writes and active-version pointers."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.skills_root = self.root / "skills"
        self.experiments_root = self.root / "experiments"
        self.skills_root.mkdir(parents=True, exist_ok=True)
        self.experiments_root.mkdir(parents=True, exist_ok=True)

    def save_version(self, version: SkillVersion, *, active: bool = False) -> None:
        skill_root = self.skills_root / _safe_id(version.skill_id)
        versions_root = skill_root / "versions"
        versions_root.mkdir(parents=True, exist_ok=True)
        self._atomic_json(
            versions_root / f"{_safe_id(version.version)}.json",
            version,
        )
        if active:
            self._atomic_json(
                skill_root / "manifest.json",
                {
                    "skillId": version.skill_id,
                    "activeVersion": version.version,
                    "checksum": version.checksum,
                },
            )

    def save_experiment(self, report: ExperimentReport) -> None:
        self._atomic_json(
            self.experiments_root / f"{_safe_id(report.experiment_id)}.json",
            report,
        )

    def load_manifest(self, skill_id: str) -> Optional[Dict[str, Any]]:
        path = self.skills_root / _safe_id(skill_id) / "manifest.json"
        return load_json(path) if path.exists() else None

    def load_experiment(self, experiment_id: str) -> Dict[str, Any]:
        path = self.experiments_root / f"{_safe_id(experiment_id)}.json"
        return load_json(path)

    @staticmethod
    def _atomic_json(target: Path, value: Any) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{target.name}.",
            dir=str(target.parent),
            text=True,
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(dumps(value) + "\n")
            os.replace(temporary_name, target)
        finally:
            temporary = Path(temporary_name)
            if temporary.exists():
                temporary.unlink()

