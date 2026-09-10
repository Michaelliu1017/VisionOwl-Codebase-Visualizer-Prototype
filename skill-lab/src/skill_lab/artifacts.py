from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path
from typing import Any

from .serialization import dumps


_SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9._-]+$")


def _safe_segment(value: str) -> str:
    if not value or not _SAFE_SEGMENT.fullmatch(value):
        raise ValueError(f"unsafe artifact path segment: {value!r}")
    return value


class LocalArtifactStore:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def write_json(self, experiment_id: str, name: str, value: Any) -> str:
        return self.write_text(experiment_id, name, dumps(value) + "\n")

    def write_text(self, experiment_id: str, name: str, value: str) -> str:
        directory = self.root / _safe_segment(experiment_id)
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / _safe_segment(name)
        self._atomic_write(target, value)
        return str(target)

    @staticmethod
    def _atomic_write(target: Path, value: str) -> None:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{target.name}.",
            dir=str(target.parent),
            text=True,
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(value)
            os.replace(temporary_name, target)
        finally:
            temporary = Path(temporary_name)
            if temporary.exists():
                temporary.unlink()

