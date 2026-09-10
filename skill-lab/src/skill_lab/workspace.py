from __future__ import annotations

import re
import shutil
import subprocess
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Type


_COMMIT_SHA = re.compile(r"^[0-9a-fA-F]{7,64}$")


class WorkspaceBuildError(RuntimeError):
    pass


@dataclass
class WorkspaceLease:
    root: Path
    path: Path

    def close(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def __enter__(self) -> Path:
        return self.path

    def __exit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc: Optional[BaseException],
        traceback: object,
    ) -> None:
        del exc_type, exc, traceback
        self.close()


class ArchiveWorkspaceBuilder:
    """Exports a commit without .git history or future commit visibility."""

    def __init__(self, *, temporary_root: Optional[Path] = None) -> None:
        self.temporary_root = temporary_root

    def build(self, repository: Path, base_sha: str) -> WorkspaceLease:
        repository = repository.resolve()
        if not _COMMIT_SHA.fullmatch(base_sha):
            raise WorkspaceBuildError("base sha must be a hexadecimal commit id")
        if not (repository / ".git").exists():
            raise WorkspaceBuildError("repository must be a local git checkout")

        root = Path(
            tempfile.mkdtemp(
                prefix="visionowl-skill-lab-",
                dir=str(self.temporary_root) if self.temporary_root else None,
            )
        )
        archive = root / "source.tar"
        workspace = root / "workspace"
        workspace.mkdir()
        try:
            completed = subprocess.run(
                [
                    "git",
                    "-C",
                    str(repository),
                    "archive",
                    "--format=tar",
                    f"--output={archive}",
                    base_sha,
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            if completed.returncode != 0:
                raise WorkspaceBuildError(completed.stderr.strip() or "git archive failed")
            self._safe_extract(archive, workspace)
            archive.unlink(missing_ok=True)
            if (workspace / ".git").exists():
                raise WorkspaceBuildError("workspace unexpectedly contains git metadata")
            return WorkspaceLease(root=root, path=workspace)
        except Exception:
            shutil.rmtree(root, ignore_errors=True)
            raise

    @staticmethod
    def _safe_extract(archive: Path, destination: Path) -> None:
        destination = destination.resolve()
        with tarfile.open(archive, "r") as handle:
            for member in handle.getmembers():
                target = (destination / member.name).resolve()
                try:
                    target.relative_to(destination)
                except ValueError as error:
                    raise WorkspaceBuildError("archive contains path traversal") from error
                if member.issym() or member.islnk():
                    raise WorkspaceBuildError("archive links are not allowed")
            if hasattr(tarfile, "data_filter"):
                handle.extractall(destination, filter="data")
            else:
                handle.extractall(destination)
