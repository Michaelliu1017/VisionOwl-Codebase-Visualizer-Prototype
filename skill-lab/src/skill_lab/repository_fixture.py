from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Mapping, Protocol, Sequence, Tuple

from .bundles import extract_github_archive
from .contracts import dataset_from_dict
from .models import EvaluationDataset


class ArchiveDownloader(Protocol):
    def download(self, path: str) -> bytes:
        ...


@dataclass(frozen=True)
class PreparedEvaluation:
    repository: Path
    hidden_tests_root: Path
    dataset: EvaluationDataset


class EvaluationFixtureError(ValueError):
    pass


class EvaluationRepositoryBuilder:
    """Builds a local history from trusted base snapshots and hidden gold files."""

    def __init__(
        self,
        downloader: ArchiveDownloader,
        *,
        root: Path,
        maximum_gold_file_bytes: int = 1_000_000,
        maximum_gold_total_bytes: int = 8_000_000,
    ) -> None:
        self.downloader = downloader
        self.root = root.resolve()
        self.maximum_gold_file_bytes = maximum_gold_file_bytes
        self.maximum_gold_total_bytes = maximum_gold_total_bytes

    def prepare(
        self,
        command: Mapping[str, Any],
        dataset_data: Mapping[str, Any],
    ) -> PreparedEvaluation:
        data = json.loads(json.dumps(dataset_data))
        development = _task_list(data, "developmentTasks")
        validation = _task_list(data, "validationTasks")
        if not development or not validation:
            raise EvaluationFixtureError("evaluation dataset needs disjoint development and validation tasks")

        repository = self.root / "repository"
        hidden_root = self.root / "hidden-tests"
        snapshots_root = self.root / "snapshots"
        for path in (repository, hidden_root, snapshots_root):
            path.mkdir(parents=True, exist_ok=True)
        _git(repository, "init", "--quiet")
        _git(repository, "config", "user.email", "skill-lab@visionowl.local")
        _git(repository, "config", "user.name", "VisionOwl Skill Lab")

        snapshot_commands = _snapshot_commands(command)
        imported: Dict[Tuple[str, str], str] = {}
        extracted: Dict[Tuple[str, str], Path] = {}
        for task in [*development, *validation]:
            metadata = _mapping(task.get("metadata"), f"task {task.get('id')} metadata")
            binding_id = _string(metadata.get("bindingId"), "metadata.bindingId")
            base_sha = _string(task.get("baseSha"), "baseSha")
            head_sha = _string(metadata.get("headSha"), "metadata.headSha")
            snapshot = snapshot_commands.get(binding_id)
            if snapshot is None:
                raise EvaluationFixtureError(f"repository binding {binding_id} is absent from the command")

            base_key = (binding_id, base_sha)
            if base_key not in extracted:
                extracted[base_key] = self._download_snapshot(
                    snapshots_root, snapshot, binding_id, base_sha
                )
            if base_key not in imported:
                imported[base_key] = _import_commit(repository, extracted[base_key], base_sha)
            task["baseSha"] = imported[base_key]

            head_key = (binding_id, head_sha)
            if head_key not in extracted:
                extracted[head_key] = self._download_snapshot(
                    snapshots_root, snapshot, binding_id, head_sha
                )
            self._attach_hidden_check(task, extracted[head_key], hidden_root)

        return PreparedEvaluation(
            repository=repository,
            hidden_tests_root=hidden_root,
            dataset=dataset_from_dict(data),
        )

    def _download_snapshot(
        self,
        snapshots_root: Path,
        snapshot: Mapping[str, Any],
        binding_id: str,
        sha: str,
    ) -> Path:
        path = snapshots_root / _safe_segment(binding_id) / _safe_segment(sha)
        if path.exists() and any(path.iterdir()):
            return path
        template = _string(snapshot.get("archiveDownloadPath"), "archiveDownloadPath")
        content = self.downloader.download(template.replace("{sha}", sha))
        extract_github_archive(content, path)
        return path

    def _attach_hidden_check(
        self,
        task: Dict[str, Any],
        head_snapshot: Path,
        hidden_root: Path,
    ) -> None:
        task_id = _safe_segment(_string(task.get("id"), "task.id"))
        metadata = _mapping(task.get("metadata"), f"task {task_id} metadata")
        changes = metadata.get("expectedChanges")
        if not isinstance(changes, list) or not changes:
            raise EvaluationFixtureError(f"task {task_id} contains no expectedChanges")

        task_hidden = hidden_root / task_id
        gold_root = task_hidden / "gold"
        gold_root.mkdir(parents=True, exist_ok=True)
        specs = []
        hidden_files = []
        total = 0
        for raw in changes[:64]:
            change = _mapping(raw, f"task {task_id} expected change")
            path = _safe_relative(_string(change.get("path"), "expectedChanges.path"))
            status = str(change.get("status") or "modified").lower()
            previous = change.get("previousPath")
            if status in {"removed", "deleted"}:
                specs.append({"path": path, "status": "removed"})
                continue
            source = head_snapshot.joinpath(*PurePosixPath(path).parts)
            mode = "exists"
            if source.is_file() and source.stat().st_size <= self.maximum_gold_file_bytes:
                content = source.read_bytes()
                if total + len(content) <= self.maximum_gold_total_bytes:
                    target = gold_root.joinpath(*PurePosixPath(path).parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(content)
                    relative_source = target.relative_to(hidden_root).as_posix()
                    relative_target = f".skill-lab-hidden/{task_id}/gold/{path}"
                    hidden_files.append({"source": relative_source, "target": relative_target})
                    total += len(content)
                    mode = "similarity"
            specs.append({"path": path, "status": status, "mode": mode})
            if status == "renamed" and isinstance(previous, str) and previous:
                specs.append({"path": _safe_relative(previous), "status": "removed"})

        config = {"minimumSimilarity": 0.35, "specs": specs}
        config_path = task_hidden / "golden.json"
        script_path = task_hidden / "golden_check.py"
        config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
        script_path.write_text(_GOLDEN_CHECK, encoding="utf-8")
        hidden_files.extend(
            [
                {
                    "source": config_path.relative_to(hidden_root).as_posix(),
                    "target": f".skill-lab-hidden/{task_id}/golden.json",
                },
                {
                    "source": script_path.relative_to(hidden_root).as_posix(),
                    "target": f".skill-lab-hidden/{task_id}/golden_check.py",
                },
            ]
        )
        runner = metadata.get("runner") if isinstance(metadata.get("runner"), dict) else {}
        existing_checks = runner.get("checks") if isinstance(runner.get("checks"), list) else []
        existing_hidden = runner.get("hiddenFiles") if isinstance(runner.get("hiddenFiles"), list) else []
        rule = "实现结果必须通过与真实历史 head commit 对照的隐藏验收"
        runner["hiddenFiles"] = [*existing_hidden, *hidden_files]
        runner["checks"] = [
            *existing_checks,
            {
                "name": "hidden:historical-golden",
                "command": ["python3", f".skill-lab-hidden/{task_id}/golden_check.py"],
                "critical": True,
                "rule": rule,
            },
        ]
        metadata["runner"] = runner
        task["metadata"] = metadata
        required = task.get("requiredRules") if isinstance(task.get("requiredRules"), list) else []
        critical = task.get("criticalRules") if isinstance(task.get("criticalRules"), list) else []
        if rule not in required:
            required.append(rule)
        if rule not in critical:
            critical.append(rule)
        task["requiredRules"] = required
        task["criticalRules"] = critical


def _snapshot_commands(command: Mapping[str, Any]) -> Dict[str, Mapping[str, Any]]:
    raw = command.get("repositorySnapshots")
    if not isinstance(raw, list) or not raw:
        raise EvaluationFixtureError("Skill Lab command contains no repository snapshots")
    result: Dict[str, Mapping[str, Any]] = {}
    for item in raw:
        value = _mapping(item, "repository snapshot")
        result[_string(value.get("bindingId"), "repositorySnapshots.bindingId")] = value
    return result


def _task_list(data: Dict[str, Any], key: str) -> list[Dict[str, Any]]:
    value = data.get(key)
    if not isinstance(value, list):
        raise EvaluationFixtureError(f"evaluation dataset {key} must be an array")
    if not all(isinstance(item, dict) for item in value):
        raise EvaluationFixtureError(f"evaluation dataset {key} contains an invalid task")
    return value


def _import_commit(repository: Path, snapshot: Path, original_sha: str) -> str:
    for item in repository.iterdir():
        if item.name == ".git":
            continue
        if item.is_dir():
            shutil.rmtree(item)
        else:
            item.unlink()
    for item in snapshot.iterdir():
        target = repository / item.name
        if item.is_dir():
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)
    _git(repository, "add", "-A")
    env = {
        **os.environ,
        "GIT_AUTHOR_DATE": "2000-01-01T00:00:00Z",
        "GIT_COMMITTER_DATE": "2000-01-01T00:00:00Z",
    }
    _git(repository, "commit", "--quiet", "--allow-empty", "-m", f"snapshot {original_sha}", env=env)
    return _git(repository, "rev-parse", "HEAD").strip()


def _git(repository: Path, *args: str, env: Mapping[str, str] | None = None) -> str:
    completed = subprocess.run(
        ["git", "-C", str(repository), *args],
        check=False,
        capture_output=True,
        text=True,
        env=dict(env) if env is not None else None,
    )
    if completed.returncode != 0:
        raise EvaluationFixtureError(completed.stderr.strip() or f"git {' '.join(args)} failed")
    return completed.stdout


def _mapping(value: Any, name: str) -> Dict[str, Any]:
    if not isinstance(value, Mapping):
        raise EvaluationFixtureError(f"{name} must be an object")
    return dict(value)


def _string(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise EvaluationFixtureError(f"{name} must be a string")
    return value


def _safe_segment(value: str) -> str:
    result = "".join(character if character.isalnum() or character in "._-" else "_" for character in value)
    return result[:120] or "item"


def _safe_relative(value: str) -> str:
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or ".." in path.parts:
        raise EvaluationFixtureError(f"unsafe repository path: {value}")
    return path.as_posix()


_GOLDEN_CHECK = r'''from __future__ import annotations

import difflib
import json
import re
import sys
from pathlib import Path

root = Path.cwd()
hidden = Path(__file__).resolve().parent
config = json.loads((hidden / "golden.json").read_text(encoding="utf-8"))
failures = []
scores = []

def normalized(value: bytes) -> str:
    try:
        text = value.decode("utf-8")
    except UnicodeDecodeError:
        return value.hex()
    return " ".join(re.findall(r"[A-Za-z_][A-Za-z0-9_]*|\d+|[^\s]", text))

for spec in config["specs"]:
    actual = root / spec["path"]
    if spec["status"] == "removed":
        if actual.exists():
            failures.append(f"expected removed path still exists: {spec['path']}")
        continue
    if not actual.is_file():
        failures.append(f"expected path is missing: {spec['path']}")
        continue
    if spec.get("mode") != "similarity":
        scores.append(1.0)
        continue
    expected = hidden / "gold" / spec["path"]
    if not expected.is_file():
        failures.append(f"hidden golden file is missing: {spec['path']}")
        continue
    ratio = difflib.SequenceMatcher(
        None,
        normalized(expected.read_bytes()),
        normalized(actual.read_bytes()),
        autojunk=False,
    ).ratio()
    scores.append(ratio)
    if ratio < config["minimumSimilarity"]:
        failures.append(f"implementation differs from historical acceptance: {spec['path']} ({ratio:.2f})")

if scores and sum(scores) / len(scores) < config["minimumSimilarity"]:
    failures.append("overall historical implementation similarity is below the threshold")
if failures:
    print("\n".join(failures), file=sys.stderr)
    raise SystemExit(1)
print(f"historical golden check passed ({len(scores)} files)")
'''
